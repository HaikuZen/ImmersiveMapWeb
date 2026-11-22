// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Loads the model tiles a frame wants and releases the ones it has left, a
 * port of the Swift `ModelTileStore`.
 *
 * A frame names the tiles in and around its view (`meshes`). The store
 * answers with the ones already on the GPU and starts loading the rest, a
 * few at a time, nearest first. A load that ends asks for a frame
 * (`invalidate`), so the on-demand render loop draws the tile without
 * waiting for a gesture.
 *
 * The tiles a frame wants are never released. The ones the camera has
 * left stay, so a return costs nothing, until the total passes the memory
 * budget, and then the longest unused go first.
 *
 * A tile the archive does not have is remembered as empty and never asked
 * again. A tile that could not be fetched is asked again after a pause
 * that grows with each failure, for as long as a frame wants it. A tile
 * whose bytes are not a tile this engine reads is reported once and not
 * asked again (the worker drops the copy it kept on disk).
 *
 * The load itself (the archive or the disk, the decode in the model
 * worker's Wasm, the upload) is the caller's (`ModelTileLoad`), so the store
 * holds only the policy, as the Swift store's test seam does.
 */

import { type Tile, tileKey } from "../../tile/tile.ts";
import { LruMemoryCache } from "../../utils/lru-memory-cache.ts";

/** What the store keeps of a loaded tile: its coordinates, what it costs on the GPU, and how to let go of it. */
export interface ModelTileStoreMesh {
  readonly tile: Tile;
  readonly costInBytes: number;
  destroy(): void;
}

/** Why a load failed: bytes that are not a tile (`unreadable`, not asked again), or an archive that could not answer (`unavailable`, asked again after a pause). */
export class ModelTileLoadFailure extends Error {
  constructor(
    readonly kind: "unreadable" | "unavailable",
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** One tile's load: the mesh on the GPU, or `missing` for a tile the archive does not hold. Throws a `ModelTileLoadFailure`. */
export type ModelTileLoad<Mesh> = (tile: Tile) => Promise<{ readonly kind: "mesh"; readonly mesh: Mesh } | { readonly kind: "missing" }>;

type LoadState = { readonly kind: "loading"; readonly failedAttempts: number } | { readonly kind: "failed"; readonly attempts: number; readonly retryAt: number };

export interface ModelTileStoreOptions<Mesh> {
  readonly costLimitBytes: number;
  readonly load: ModelTileLoad<Mesh>;
  /** A load ended, or a retry's pause did: the frame that draws it is wanted. */
  readonly invalidate: () => void;
  /** Seconds. */
  readonly now?: () => number;
  /** Runs `body` after `seconds` (the end of a retry's pause asks for a frame). */
  readonly schedule?: (seconds: number, body: () => void) => void;
  /** The first unreadable tile of each minute is reported here. */
  readonly warn?: (message: string) => void;
}

export class ModelTileStore<Mesh extends ModelTileStoreMesh> {
  /** The zoom of the tiles a model archive holds (`ModelTileContents.tileZoom`). */
  static readonly tileZoom = 14;
  static readonly maximumConcurrentLoads = 4;
  static readonly retryBaseDelay = 5;
  static readonly retryMaximumDelay = 60;
  /** The empty tiles remembered before the list starts over: a session that has crossed this many tiles has long left the first ones. */
  static readonly maximumRememberedEmptyTiles = 16_384;

  private readonly cache: LruMemoryCache<string, Mesh>;
  private readonly states = new Map<string, LoadState>();
  private readonly emptyTiles = new Set<string>();
  private wantedTiles: ReadonlySet<string> = new Set();
  private readonly costLimitBytes: number;
  private readonly now: () => number;
  private readonly schedule: (seconds: number, body: () => void) => void;
  private readonly warn: (message: string) => void;
  private lastWarning = -Infinity;
  private destroyed = false;

  constructor(private readonly options: ModelTileStoreOptions<Mesh>) {
    this.costLimitBytes = Math.max(0, options.costLimitBytes);
    this.cache = new LruMemoryCache(this.costLimitBytes);
    this.now = options.now ?? (() => performance.now() / 1000);
    this.schedule = options.schedule ?? ((seconds, body) => setTimeout(body, seconds * 1000));
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * One call a frame. `wanted` is the tiles the frame wants, nearest first:
   * the order the missing ones start loading in. Returns the wanted tiles
   * on the GPU now, in the same order, and the ones still on their way. A
   * tile waiting out its retry after a failure is not on its way: what
   * waits for it does not wait forever.
   */
  meshes(wanted: readonly Tile[]): { ready: Mesh[]; pending: Tile[] } {
    const ready: Mesh[] = [];
    const pending: Tile[] = [];
    const toLoad: Tile[] = [];
    this.wantedTiles = new Set(wanted.map(tileKey));
    let running = 0;
    for (const state of this.states.values()) if (state.kind === "loading") running++;
    const time = this.now();
    for (const tile of wanted) {
      const key = tileKey(tile);
      const mesh = this.cache.value(key);
      if (mesh !== undefined) {
        ready.push(mesh);
        continue;
      }
      if (this.emptyTiles.has(key)) continue;
      const state = this.states.get(key);
      if (state?.kind === "loading") {
        pending.push(tile);
        continue;
      }
      if (state?.kind === "failed" && time < state.retryAt) continue;
      // Past the limit the tile waits for a later frame: a load that ends asks for one.
      pending.push(tile);
      if (running < ModelTileStore.maximumConcurrentLoads) {
        running++;
        toLoad.push(tile);
      }
    }
    for (const tile of toLoad) {
      const key = tileKey(tile);
      const state = this.states.get(key);
      this.states.set(key, { kind: "loading", failedAttempts: state?.kind === "failed" ? state.attempts : 0 });
      this.startLoad(tile, key);
    }
    return { ready, pending };
  }

  /** Releases what the last frame did not want (the Swift memory warning). */
  handleMemoryWarning(): void {
    this.release(this.cache.trim(0, this.wantedTiles));
  }

  /** Releases the longest unused tiles past the budget. */
  evict(): void {
    this.release(this.cache.trim(this.costLimitBytes, this.wantedTiles));
  }

  /** What the loaded tiles hold on the GPU. */
  get residentCostInBytes(): number {
    return this.cache.totalCost;
  }

  get residentTiles(): ReadonlySet<string> {
    return new Set(this.cache.keys());
  }

  /** Lets go of every tile. A load still on its way is dropped when it ends. */
  destroy(): void {
    this.destroyed = true;
    this.release(this.cache.removeAll());
  }

  private startLoad(tile: Tile, key: string): void {
    this.options.load(tile).then(
      (outcome) => this.finishLoad(key, outcome.kind === "mesh" ? outcome.mesh : undefined),
      (error: unknown) => {
        if (error instanceof ModelTileLoadFailure && error.kind === "unreadable") {
          this.report(`ImmersiveMap: model tile ${key} cannot be read (${error.reason}). Its models are not drawn. Check that the model archive was baked for this version of the engine.`);
          this.finishLoad(key, undefined);
        } else {
          if (error instanceof ModelTileLoadFailure && error.reason.startsWith("archive unreadable")) {
            this.report(`ImmersiveMap: the model archive could not be read (${error.reason}). Check that modelArchive points at a PMTiles v3 archive of model tiles.`);
          }
          this.failLoad(key);
        }
      },
    );
  }

  private finishLoad(key: string, mesh: Mesh | undefined): void {
    this.states.delete(key);
    if (this.destroyed) {
      mesh?.destroy();
      return;
    }
    if (mesh !== undefined) {
      this.release(this.cache.set(key, mesh, mesh.costInBytes, this.wantedTiles));
    } else {
      if (this.emptyTiles.size >= ModelTileStore.maximumRememberedEmptyTiles) this.emptyTiles.clear();
      this.emptyTiles.add(key);
    }
    // An empty tile changes no picture, but a load that ended frees a slot
    // the next waiting tile takes on the frame this asks for.
    this.options.invalidate();
  }

  private failLoad(key: string): void {
    const state = this.states.get(key);
    const attempts = state?.kind === "loading" ? state.failedAttempts + 1 : 1;
    const delay = Math.min(ModelTileStore.retryMaximumDelay, ModelTileStore.retryBaseDelay * 2 ** (attempts - 1));
    this.states.set(key, { kind: "failed", attempts, retryAt: this.now() + delay });
    if (this.destroyed) return;
    // The slot is free now, and the pause's end must draw a frame:
    // on-demand rendering would otherwise wait for a gesture.
    this.options.invalidate();
    this.schedule(delay, () => {
      if (!this.destroyed) this.options.invalidate();
    });
  }

  /** A warning about the archive, one line a minute: every wanted tile carries the same news. */
  private report(message: string): void {
    const time = this.now();
    if (time - this.lastWarning < 60) return;
    this.lastWarning = time;
    this.warn(message);
  }

  private release(entries: readonly { readonly value: Mesh }[]): void {
    for (const entry of entries) entry.value.destroy();
  }
}
