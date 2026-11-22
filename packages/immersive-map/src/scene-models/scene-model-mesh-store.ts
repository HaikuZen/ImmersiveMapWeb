// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Loader and LRU owner of the scene models' meshes, a port of the Swift
 * `SceneModelMeshStore`, keyed and deduplicated by source
 * (`sceneModelSourceKey`): any number of models sharing a source share one
 * loaded mesh. A load that ends asks for a frame (`invalidate`), as a tile
 * does. A failed load is tried again after a cooldown that grows with each
 * attempt, up to `maxLoadAttempts`, and the cooldown's end asks for a frame
 * too (on-demand rendering would otherwise wait for a gesture).
 *
 * The load itself (the fetch, the glTF or OBJ parse, the GPU upload) is the
 * caller's (`SceneModelMeshLoad`), so the store holds only the policy.
 */

import { LruMemoryCache } from "../utils/lru-memory-cache.ts";

export interface SceneModelStoreMesh {
  readonly costInBytes: number;
  destroy(): void;
}

/** One source's load. Rejects when the asset cannot be read. */
export type SceneModelMeshLoad<Source, Mesh> = (source: Source) => Promise<Mesh>;

type LoadState = { readonly kind: "loading"; readonly attempt: number } | { readonly kind: "failed"; readonly attempts: number; readonly retryAt: number };

export interface SceneModelMeshStoreOptions<Source, Mesh> {
  readonly load: SceneModelMeshLoad<Source, Mesh>;
  readonly invalidate: () => void;
  readonly costLimitBytes?: number;
  /** Seconds. */
  readonly now?: () => number;
  readonly schedule?: (seconds: number, body: () => void) => void;
  /** A failed load is reported here, once a source. */
  readonly warn?: (message: string) => void;
}

export class SceneModelMeshStore<Source, Mesh extends SceneModelStoreMesh> {
  static readonly defaultCostLimitBytes = 128 * 1024 * 1024;
  static readonly maxLoadAttempts = 3;
  static readonly retryCooldownBase = 5;

  private readonly cache: LruMemoryCache<string, Mesh>;
  private readonly states = new Map<string, LoadState>();
  private referenced: ReadonlySet<string> = new Set();
  private readonly now: () => number;
  private readonly schedule: (seconds: number, body: () => void) => void;
  private readonly warn: (message: string) => void;
  private destroyed = false;

  constructor(private readonly options: SceneModelMeshStoreOptions<Source, Mesh>) {
    this.cache = new LruMemoryCache(options.costLimitBytes ?? SceneModelMeshStore.defaultCostLimitBytes);
    this.now = options.now ?? (() => performance.now() / 1000);
    this.schedule = options.schedule ?? ((seconds, body) => setTimeout(body, seconds * 1000));
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * One call a frame: remembers the referenced sources (kept from
   * eviction), starts the loads of the missing ones and the retries that
   * are due, and returns the meshes ready now, by key.
   */
  requestMeshes(sources: ReadonlyMap<string, Source>): Map<string, Mesh> {
    this.referenced = new Set(sources.keys());
    const ready = new Map<string, Mesh>();
    const time = this.now();
    for (const [key, source] of sources) {
      const mesh = this.cache.value(key);
      if (mesh !== undefined) {
        ready.set(key, mesh);
        continue;
      }
      const state = this.states.get(key);
      if (state?.kind === "loading") continue;
      if (state?.kind === "failed") {
        if (state.attempts >= SceneModelMeshStore.maxLoadAttempts || time < state.retryAt) continue;
        this.start(key, source, state.attempts + 1);
        continue;
      }
      this.start(key, source, 1);
    }
    return ready;
  }

  /** The failed attempts of a source, `undefined` while it loads or is ready. */
  failureAttempts(key: string): number | undefined {
    const state = this.states.get(key);
    return state?.kind === "failed" ? state.attempts : undefined;
  }

  /** Releases the meshes no model references (the Swift memory warning). */
  handleMemoryWarning(): void {
    this.release(this.cache.trim(0, this.referenced));
  }

  destroy(): void {
    this.destroyed = true;
    this.release(this.cache.removeAll());
  }

  private start(key: string, source: Source, attempt: number): void {
    this.states.set(key, { kind: "loading", attempt });
    this.options.load(source).then(
      (mesh) => {
        this.states.delete(key);
        if (this.destroyed) {
          mesh.destroy();
          return;
        }
        this.release(this.cache.set(key, mesh, mesh.costInBytes, this.referenced));
        this.options.invalidate();
      },
      (error: unknown) => {
        const cooldown = SceneModelMeshStore.retryCooldownBase * attempt;
        this.states.set(key, { kind: "failed", attempts: attempt, retryAt: this.now() + cooldown });
        if (attempt === 1) this.warn(`ImmersiveMap: the scene model ${key} could not be loaded (${error instanceof Error ? error.message : String(error)}).`);
        if (this.destroyed || attempt >= SceneModelMeshStore.maxLoadAttempts) return;
        this.schedule(cooldown, () => {
          if (!this.destroyed) this.options.invalidate();
        });
      },
    );
  }

  private release(entries: readonly { readonly value: Mesh }[]): void {
    for (const entry of entries) entry.value.destroy();
  }
}
