// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GroundReliefSettings } from "../../../configuration/tile-settings.ts";
import type { ClosedRange } from "../../../math/closed-range.ts";
import type { Vec2 } from "../../../math/vec.ts";
import type { PlaceTile, ResidentTile, VisibleTile } from "../../placement/place-tile.ts";
import { type Tile, tileKey, tileParentAt } from "../../tile.ts";
import type { FlatRingBand } from "../../visibility/flat-ring-rules.ts";
import type { GroundReliefTerrainDemand, TerrainDemandRequest } from "../../store/working-set.ts";
import { GroundReliefDemand } from "../demand/ground-relief-demand.ts";
import { GroundReliefTerrainZooms } from "../demand/ground-relief-terrain-zooms.ts";
import { GroundReliefEdgeWeld, type GroundReliefEdgeWeldWrite } from "./ground-relief-edge-weld.ts";
import { GroundReliefLoadStates } from "./ground-relief-load-states.ts";
import { GroundReliefOcclusionKey } from "./ground-relief-occlusion.ts";
import { GroundReliefReleasedCache } from "./ground-relief-released-cache.ts";
import { GroundReliefStatusSnapshot, type GroundReliefTileStatus } from "./ground-relief-status-snapshot.ts";
import type { GroundReliefTerrainSource } from "./ground-relief-terrain-source.ts";
import { GroundReliefTile, type ReliefTexture } from "./ground-relief-tile.ts";

/**
 * The GPU side of the terrain tiles, the store's seam: the map hands in
 * WebGPU textures (`GroundReliefGpuTextures`), a test plain objects.
 */
export interface GroundReliefTextures {
  /** A tile's heights as an `r16float` texture, row 0 at the north edge. */
  heights(size: number, halves: Uint16Array): ReliefTexture;
  /** A rectangle of a heights texture written again (a weld), before the next frame's draws. */
  writeHeights(texture: ReliefTexture, x: number, y: number, width: number, height: number, values: Uint16Array<ArrayBuffer>): void;
  /**
   * A tile's occlusion of the sky under `key` as an `r8unorm` texture,
   * computed from its heights (on the GPU, decision B10), and how long the
   * computation took to encode. Undefined for a key that computes nothing.
   */
  occlusion(tile: Tile, terrain: GroundReliefTile, key: GroundReliefOcclusionKey): { texture: ReliefTexture; milliseconds: number } | undefined;
  /** Lets go of a texture once the frames that read it are submitted. */
  release(texture: ReliefTexture): void;
}

/** What the store tells the render loop: a frame to draw, as a map tile's arrival does. */
export type GroundReliefInvalidate = () => void;

/**
 * The terrain tiles the flattened ground rises by
 * (`GroundReliefSettings`), a port of the Swift `GroundReliefStore`: loads
 * them from a terrain source and keeps them as textures, with their heights
 * on the CPU.
 *
 * The frame states once which terrain tiles it needs, nearest first
 * (`requestTiles`, `GroundReliefDemand`), as it states its map tiles: the
 * store loads them in that order, a few at a time
 * (`GroundReliefSettings.maximumConcurrentLoads`), and keeps them while
 * they are wanted. Whatever reads the terrain (`terrain`, `finestTerrain`)
 * only reads, and never starts a load. A terrain tile that arrives asks for
 * a frame (`invalidate`), as a map tile does, so the on-demand render loop
 * draws it. Its edges are welded to its neighbours' of the same zoom
 * (`GroundReliefEdgeWeld`), written at the next frame's start
 * (`applyPendingWelds`).
 *
 * A terrain tile the source does not have is remembered as missing, and its
 * ancestor is wanted in its place, down to the source's floor. One that
 * could not be fetched is asked again after a pause that grows with each
 * failure (`GroundReliefLoadStates`). A load the camera has left behind
 * finishes and lands into nothing. The tiles the frame stopped reading wait
 * in a small cache for the zoom back (`GroundReliefReleasedCache`).
 *
 * The store holds tiles and nothing of a frame: how far the relief has
 * risen, the datum, the light and every other value a frame draws by are
 * `GroundReliefFrameState`'s. The planner reaches the store through
 * `GroundReliefTerrainDemand` alone. Main thread only: the loads run in the
 * tile workers and land here as their promises resolve.
 */
export class GroundReliefStore<R extends ResidentTile = ResidentTile> implements GroundReliefTerrainDemand<R> {
  /**
   * The texels across a terrain tile: Mapterhorn's 512. The camera's march
   * is stepped by it (`CameraTerrainFollow.sampleStepWorld`).
   */
  static readonly nominalTerrainTileSize = 512;

  /** A frame to draw: set by the map to its render loop. */
  invalidate: GroundReliefInvalidate = () => undefined;

  private readonly minimumSourceZoom: number;
  private readonly terrains = new Map<string, { tile: Tile; terrain: GroundReliefTile }>();
  private readonly released: GroundReliefReleasedCache;
  private readonly loads: GroundReliefLoadStates;
  /** The frame's demand, nearest first, and the same by `tileKey`: loaded in that order, and what the store keeps. */
  private wantedOrder: Tile[] = [];
  private wantedKeys = new Set<string>();
  private readonly loadAborts = new Map<string, AbortController>();
  private pendingWelds: GroundReliefEdgeWeldWrite[] = [];
  private currentVersion = 0;
  private currentZooms: GroundReliefTerrainZooms;
  private heightRange: ClosedRange | undefined;
  private heightRangeVersion: number | undefined;
  private occlusionKeyValue: GroundReliefOcclusionKey;
  /** Grows with every change of the occlusion's key: a computation for an older one lands into nothing. */
  private occlusionGeneration = 0;
  private occlusionMillisecondsLast = 0;
  private destroyed = false;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * `source` gives the tiles' heights, `occlusionKey` is what their
   * occlusion of the sky is computed with until the frame says otherwise
   * (`setOcclusionKey`), and `now` the clock in seconds the retries wait
   * by, a test's seam.
   */
  constructor(
    settings: GroundReliefSettings,
    private readonly source: GroundReliefTerrainSource,
    private readonly textures: GroundReliefTextures,
    occlusionKey: GroundReliefOcclusionKey = GroundReliefOcclusionKey.make(3000, 8, 128),
    private readonly now: () => number = () => performance.now() / 1000,
  ) {
    this.minimumSourceZoom = Math.max(0, settings.minimumSourceZoom);
    this.released = new GroundReliefReleasedCache(settings.releasedCacheBytes, (terrain) => this.releaseTextures(terrain));
    this.loads = new GroundReliefLoadStates(settings.maximumConcurrentLoads);
    this.currentZooms = new GroundReliefTerrainZooms(Math.max(0, settings.cameraTerrainZoom), Math.max(0, settings.displacementMaximumZoom));
    this.occlusionKeyValue = occlusionKey;
  }

  // MARK: What the terrain is

  /**
   * Grows with every terrain tile that arrives, leaves, is welded or turns
   * out not to come, and with every occlusion computed: what is placed by
   * the terrain (the planner's placements, the labels) is placed again
   * when it changes.
   */
  get version(): number {
    return this.currentVersion;
  }

  /** Which terrain tiles the ground and the camera read this frame. */
  get zooms(): GroundReliefTerrainZooms {
    return this.currentZooms;
  }

  /** The zoom of the terrain tiles the camera reads (`GroundReliefSettings.cameraTerrainZoom`). */
  get cameraTerrainZoom(): number {
    return this.currentZooms.cameraZoom;
  }

  /** The key the tiles' occlusion of the sky is computed with now. */
  get occlusionKey(): GroundReliefOcclusionKey {
    return this.occlusionKeyValue;
  }

  /** The frame's ring bands, once a frame, before anything of the frame reads the relief. */
  setBands(bands: readonly FlatRingBand[]): void {
    this.currentZooms = new GroundReliefTerrainZooms(this.currentZooms.cameraZoom, this.currentZooms.displacementMaximumZoom, bands);
  }

  /** The zoom a ring of `zoom` reads its terrain at, by the frame's ring rules. */
  terrainZoom(forTargetZoom: number): number {
    return this.currentZooms.terrainZoom(forTargetZoom);
  }

  /**
   * The lowest and the highest height over every terrain tile in, in metres
   * before the exaggeration, `undefined` with none in. The coverage walks
   * the frustum's footprint over this range of ground, so a tile the relief
   * lifts into view past the plane's footprint is drawn.
   */
  get heightRangeMetres(): ClosedRange | undefined {
    if (this.heightRangeVersion !== this.currentVersion) {
      let range: ClosedRange | undefined;
      for (const { terrain } of this.terrains.values()) {
        const tileRange = terrain.heightRange;
        range = range === undefined ? tileRange : { lowerBound: Math.min(range.lowerBound, tileRange.lowerBound), upperBound: Math.max(range.upperBound, tileRange.upperBound) };
      }
      this.heightRange = range;
      this.heightRangeVersion = this.currentVersion;
    }
    return this.heightRange;
  }

  /**
   * A terrain tile in, with its occlusion of the sky when that is computed
   * under the current key: `undefined` for a tile not in, which includes
   * one the source has not got or does not answer for.
   */
  terrain(at: Tile): { terrain: GroundReliefTile; occlusion: ReliefTexture | undefined } | undefined {
    const entry = this.terrains.get(tileKey(at));
    if (entry === undefined) return undefined;
    const terrain = entry.terrain;
    return { terrain, occlusion: GroundReliefOcclusionKey.equals(terrain.occlusionKey, this.occlusionKeyValue) ? terrain.occlusion : undefined };
  }

  /**
   * The terrain tile of `terrainZoom` over `tile` (its own address when that
   * is coarser) or, while that is on its way, the finest coarser one in.
   * `orCoarser` false asks for the terrain of `terrainZoom` only.
   */
  finestTerrain(over: Tile, terrainZoom: number, orCoarser = true): { source: Tile; terrain: GroundReliefTile } | undefined {
    let source = tileParentAt(over, Math.max(Math.min(terrainZoom, over.z), 0)) ?? over;
    for (;;) {
      const entry = this.terrains.get(tileKey(source));
      if (entry !== undefined) return { source, terrain: entry.terrain };
      if (!orCoarser || source.z <= 0) return undefined;
      source = tileParentAt(source, source.z - 1)!;
    }
  }

  // MARK: Demand

  /**
   * The terrain tile a source drawn in a ring of `targetZoom` rises by, the
   * one the planner binds its placement to once it is in: the ring's
   * terrain over the tile or, where the source has no such tile, the finest
   * ancestor it has, down to the source's floor.
   */
  terrainSource(tile: Tile, targetZoom: number): Tile {
    return this.existingSource(this.currentZooms.terrainTile(tile, targetZoom));
  }

  /**
   * Whether the source has no terrain where a ring of `targetZoom` reads it
   * under a point of the world (normalized world mercator): false until the
   * source has answered.
   */
  ringTerrainIsMissing(under: Vec2, targetZoom: number): boolean {
    const count = 2 ** targetZoom;
    const x = Math.min(Math.max(Math.floor(wrapUnit(under[0]) * count), 0), count - 1);
    const y = Math.min(Math.max(Math.floor(Math.min(Math.max(under[1], 0), 1) * count), 0), count - 1);
    return this.loads.isMissing(this.currentZooms.terrainTile({ x, y, z: targetZoom }, targetZoom));
  }

  /** The terrain tile a source drawn in a ring of `targetZoom` displaces its grid by (`PlaceTile.displacement`). */
  displacementSource(tile: Tile, targetZoom: number): Tile {
    return this.existingSource(this.currentZooms.displacementTile(tile, targetZoom));
  }

  /**
   * Whether a terrain tile is in, or counts as in because it cannot come
   * (`GroundReliefLoadStates.isUnavailable`): a placement bound to one that
   * cannot come draws flat, so a map whose terrain source is out of reach
   * shows its tiles on the plane, not holes.
   */
  isResident(tile: Tile): boolean {
    return this.terrains.has(tileKey(tile)) || this.loads.isUnavailable(tile);
  }

  /** Whether a wanted tile is still to come: on its way, or failed and waiting for its retry. */
  get hasLoadsPending(): boolean {
    return this.wantedOrder.some((tile) => !this.terrains.has(tileKey(tile)));
  }

  /** The wanted terrain tiles still on their way: what a still capture settles on. */
  get pendingWantedCount(): number {
    return this.loads.pendingCount(this.wantedOrder, (tile) => this.terrains.has(tileKey(tile)), this.now());
  }

  /** The relief's frame values the demand reads, set by the frame state before the working set asks (`GroundReliefFrameState`). */
  demandFrame: { readonly isActive: boolean; readonly fromTileZoom: number; readonly collapseTileZoom: number } = { isActive: false, fromTileZoom: 0, collapseTileZoom: Number.MAX_SAFE_INTEGER };

  /**
   * The frame's terrain demand, once a frame (`TileWorkingSet`): the
   * terrain the frame reads, nearest first, out of what the planner
   * planned. Asked for on the terrain and while the relief is collapsed past
   * its zooms, then for the tiles of the collapse's zoom the relief reads
   * when it rises back, no finer. Below the relief's tile zoom, and off the
   * flat map, nothing.
   */
  request(request: TerrainDemandRequest<R>): void {
    const frame = this.demandFrame;
    if (!request.onFlatMap || !(frame.isActive || request.tileZoom >= frame.fromTileZoom)) {
      this.requestTiles([]);
      return;
    }
    this.requestTiles(
      GroundReliefDemand.tiles({
        targets: request.targets,
        shown: request.shown,
        also: request.missing,
        centerWorldMercator: request.centerWorldMercator,
        zooms: this.currentZooms,
        maximumTargetZoom: frame.isActive ? Number.MAX_SAFE_INTEGER : frame.collapseTileZoom,
        terrainSource: (tile, targetZoom) => ({ terrain: this.terrainSource(tile, targetZoom), displacement: this.displacementSource(tile, targetZoom) }),
      }),
    );
  }

  /**
   * The frame's terrain, nearest first: what the store loads, in that
   * order, and all it keeps. A terrain the frame no longer asks for goes to
   * the released cache, and a wanted tile found there comes back from it at
   * once, welded to its neighbours in as a loaded one is. A tile the source
   * does not have is replaced by its ancestor, down to the source's floor.
   */
  requestTiles(tiles: readonly Tile[]): void {
    const order: Tile[] = [];
    const seen = new Set<string>();
    for (const tile of tiles) {
      const source = this.existingSource(tile);
      const key = tileKey(source);
      if (this.loads.isMissing(source) || seen.has(key)) continue;
      seen.add(key);
      order.push(source);
    }
    this.wantedOrder = order;
    this.wantedKeys = seen;
    let changed = false;
    for (const [key, entry] of this.terrains) {
      if (seen.has(key)) continue;
      this.terrains.delete(key);
      this.released.keep(entry.tile, entry.terrain);
      changed = true;
    }
    for (const tile of order) {
      const key = tileKey(tile);
      if (this.terrains.has(key)) continue;
      const terrain = this.released.take(tile);
      if (terrain === undefined) continue;
      this.terrains.set(key, { tile, terrain });
      this.queueWelds(tile, terrain);
      changed = true;
    }
    if (changed) this.currentVersion += 1;
    this.startWantedLoads();
  }

  /** Releases every terrain tile, for a memory warning and an eviction. */
  removeAll(): void {
    for (const { terrain } of this.terrains.values()) this.releaseTextures(terrain);
    this.terrains.clear();
    this.released.removeAll();
    this.currentVersion += 1;
  }

  /** Stops every load and lets go of every tile: the map is torn down. */
  destroy(): void {
    this.destroyed = true;
    for (const abort of this.loadAborts.values()) abort.abort();
    this.loadAborts.clear();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.removeAll();
  }

  /** `tile` or, where the source has no such tile, the finest ancestor it has, down to the floor. */
  private existingSource(tile: Tile): Tile {
    let source = tile;
    while (this.loads.isMissing(source) && source.z > this.minimumSourceZoom) {
      source = tileParentAt(source, source.z - 1)!;
    }
    return source;
  }

  // MARK: The occlusion of the sky

  /**
   * What the tiles' occlusion of the sky is computed with
   * (`GroundReliefFrameState.setOcclusion`). A new key computes every tile
   * in, and every tile kept, again, and each tile draws its new occlusion
   * as it is done. Until then a tile draws none (`terrain`).
   */
  setOcclusionKey(key: GroundReliefOcclusionKey): void {
    if (GroundReliefOcclusionKey.equals(key, this.occlusionKeyValue)) return;
    this.occlusionKeyValue = key;
    this.occlusionGeneration += 1;
    const generation = this.occlusionGeneration;
    const tiles = [...this.terrains.values(), ...this.released.all];
    // A few tiles a frame: a tile costs a few tenths of a millisecond of the
    // GPU (docs/benchmarks/B10-occlusion.md), and a whole store at once
    // would take a frame's budget.
    const next = (index: number) => {
      if (this.destroyed || generation !== this.occlusionGeneration) return;
      const end = Math.min(index + GroundReliefStore.occlusionTilesPerFrame, tiles.length);
      for (let i = index; i < end; i++) {
        const { tile, terrain } = tiles[i]!;
        const computed = this.textures.occlusion(tile, terrain, key);
        this.replaceOcclusion(terrain, computed?.texture, key);
        if (computed !== undefined) this.occlusionMillisecondsLast = computed.milliseconds;
      }
      this.currentVersion += 1;
      this.invalidate();
      if (end < tiles.length) this.schedule(() => next(end));
    };
    next(0);
  }

  /** The tiles whose occlusion is computed again a frame under a new key. */
  static readonly occlusionTilesPerFrame = 4;

  /** Runs a step at the next frame: the store's seam for the occlusion's spread over frames. */
  schedule: (step: () => void) => void = (step) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => step());
    else setTimeout(step, 16);
  };

  private replaceOcclusion(terrain: GroundReliefTile, texture: ReliefTexture | undefined, key: GroundReliefOcclusionKey): void {
    const previous = terrain.occlusion;
    terrain.setOcclusion(texture, key);
    if (previous !== undefined && previous !== texture) this.textures.release(previous);
  }

  // MARK: Welds

  private queueWelds(tile: Tile, terrain: GroundReliefTile): void {
    const writes = GroundReliefEdgeWeld.writes(tile, terrain, (neighbour) => this.terrains.get(tileKey(neighbour))?.terrain);
    for (const write of writes) this.pendingWelds.push(write);
  }

  /**
   * Writes the welds queued since the last frame (`GroundReliefEdgeWeld`):
   * the texels on the CPU, where they are read, and the textures through the
   * queue, before the frame's own commands. WebGPU orders the queue's
   * writes after every submit before them and before the next, so no
   * texture changes under a frame in flight. Called once a frame, before
   * the frame's command encoder. Returns whether anything was written.
   */
  applyPendingWelds(): boolean {
    const writes = this.pendingWelds;
    if (writes.length === 0) return false;
    this.pendingWelds = [];
    for (const write of writes) {
      write.terrain.writeTexels(write.values, write.x, write.y, write.width, write.height);
      this.textures.writeHeights(write.terrain.texture, write.x, write.y, write.width, write.height, write.values);
    }
    // What is placed by the terrain on the CPU (the labels) is placed again on the welded edges.
    this.currentVersion += 1;
    return true;
  }

  // MARK: Status

  /** What the store holds and does now, for the debug panel's relief tab, with the frame's own values. */
  statusSnapshot(isActive: boolean, standingShare: number, datumMetres: number): GroundReliefStatusSnapshot {
    const time = this.now();
    const tiles: GroundReliefTileStatus[] = [];
    const listed = new Set<string>();
    let wantedResident = 0;
    const status = (tile: Tile, priority: number | undefined): GroundReliefTileStatus => {
      const key = tileKey(tile);
      const entry = this.terrains.get(key);
      if (entry !== undefined) {
        return { tile, state: "resident", priority, bytes: entry.terrain.costInBytes, heightRange: entry.terrain.heightRange, seconds: 0, attempts: 0 };
      }
      const state = this.loads.statesByTile.get(key);
      if (state?.kind === "loading") {
        const started = this.loads.startedAt.get(key) ?? time;
        return { tile, state: "loading", priority, bytes: 0, heightRange: undefined, seconds: Math.trunc(Math.max(0, time - started)), attempts: state.failedAttempts };
      }
      if (state?.kind === "failed") {
        return { tile, state: "failed", priority, bytes: 0, heightRange: undefined, seconds: Math.ceil(Math.max(0, state.retryAt - time)), attempts: state.attempts };
      }
      return { tile, state: "queued", priority, bytes: 0, heightRange: undefined, seconds: 0, attempts: 0 };
    };
    this.wantedOrder.forEach((tile, priority) => {
      const entry = status(tile, priority);
      if (entry.state === "resident") wantedResident += 1;
      tiles.push(entry);
      listed.add(tileKey(tile));
    });
    const kept = new Map<string, Tile>();
    for (const [key, entry] of this.terrains) if (!listed.has(key)) kept.set(key, entry.tile);
    for (const key of this.loads.statesByTile.keys()) {
      if (listed.has(key) || kept.has(key)) continue;
      const [z, x, y] = key.split("/").map(Number);
      kept.set(key, { x: x!, y: y!, z: z! });
    }
    const keptTiles = [...kept.values()].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    for (const tile of keptTiles) tiles.push(status(tile, undefined));
    let residentBytes = 0;
    let occlusionComputed = 0;
    for (const { terrain } of this.terrains.values()) {
      residentBytes += terrain.costInBytes;
      if (terrain.occlusion !== undefined && GroundReliefOcclusionKey.equals(terrain.occlusionKey, this.occlusionKeyValue)) occlusionComputed += 1;
    }
    return new GroundReliefStatusSnapshot({
      tiles,
      isActive,
      standingShare,
      datumMetres,
      cameraTerrainZoom: this.currentZooms.cameraZoom,
      terrainByRing: this.currentZooms.statusText,
      wantedCount: this.wantedOrder.length,
      wantedResidentCount: wantedResident,
      residentCount: this.terrains.size,
      residentBytes,
      releasedCount: this.released.count,
      releasedBytes: this.released.bytes,
      releasedCacheBytes: this.released.capacityBytes,
      occlusionComputedCount: occlusionComputed,
      occlusionMillisecondsLast: this.occlusionMillisecondsLast,
      loadingCount: this.loads.activeLoads,
      maximumConcurrentLoads: this.loads.maximumConcurrentLoads,
      failedCount: this.loads.failedCount,
      missingCount: this.loads.missing.size,
    });
  }

  // MARK: Loading

  /** Starts the loads of the wanted tiles that are neither in nor on their way, nearest first, while slots are free. */
  private startWantedLoads(): void {
    if (this.destroyed) return;
    const started = this.loads.start(this.wantedOrder, (tile) => this.terrains.has(tileKey(tile)), this.now());
    for (const tile of started) this.startLoad(tile);
  }

  private startLoad(tile: Tile): void {
    const key = tileKey(tile);
    const abort = new AbortController();
    this.loadAborts.set(key, abort);
    void this.source.heights(tile, abort.signal).then(
      (response) => {
        if (this.destroyed) return;
        if (response.kind === "missing") {
          this.finishLoad(tile, undefined);
          return;
        }
        const heights = response.heights;
        const terrain = new GroundReliefTile(this.textures.heights(heights.size, heights.halves), heights.size, heights.halves, {
          lowerBound: Math.min(heights.minMetres, heights.maxMetres),
          upperBound: Math.max(heights.minMetres, heights.maxMetres),
        });
        // The occlusion of a tile just decoded, under the key of the moment,
        // before the tile is in (decision B10: on the GPU, queued before the
        // frame that first draws the tile).
        const occlusionKey = this.occlusionKeyValue;
        const computed = this.textures.occlusion(tile, terrain, occlusionKey);
        terrain.setOcclusion(computed?.texture, occlusionKey);
        if (computed !== undefined) this.occlusionMillisecondsLast = computed.milliseconds;
        this.finishLoad(tile, terrain);
      },
      () => {
        if (this.destroyed) return;
        this.failLoad(tile);
      },
    );
  }

  /** A load that ended: the terrain, or `undefined` for a tile the source does not have, which is then remembered as missing. */
  private finishLoad(tile: Tile, terrain: GroundReliefTile | undefined): void {
    const key = tileKey(tile);
    this.loadAborts.delete(key);
    this.loads.finish(tile, terrain === undefined);
    if (terrain !== undefined) {
      // A load the frame no longer wants lands into nothing.
      if (this.wantedKeys.has(key)) {
        this.terrains.set(key, { tile, terrain });
        this.currentVersion += 1;
        // Its edges to the neighbours in, and theirs to it: written with the
        // frame, never into a texture a frame may be reading.
        this.queueWelds(tile, terrain);
      } else {
        this.releaseTextures(terrain);
      }
    } else {
      // The planner reads the tile as in and flat (`isResident`).
      this.currentVersion += 1;
    }
    this.startWantedLoads();
    // A missing tile changes no picture, but the next frame asks for its
    // ancestor, or places the tile flat.
    this.invalidate();
  }

  private failLoad(tile: Tile): void {
    this.loadAborts.delete(tileKey(tile));
    const failure = this.loads.fail(tile, this.now());
    // The planner reads the tile as in and flat from now on (`isResident`): a plan over it.
    if (failure.becameUnavailable) this.currentVersion += 1;
    this.startWantedLoads();
    // The pause's end must draw a frame: on-demand rendering would
    // otherwise wait for a gesture.
    this.invalidate();
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (!this.destroyed) this.invalidate();
    }, failure.delay * 1000);
    this.retryTimers.add(timer);
  }

  private releaseTextures(terrain: GroundReliefTile): void {
    this.textures.release(terrain.texture);
    if (terrain.occlusion !== undefined) this.textures.release(terrain.occlusion);
    terrain.setOcclusion(undefined, undefined);
  }
}

function wrapUnit(x: number): number {
  const fraction = x - Math.floor(x);
  return fraction < 0 ? fraction + 1 : fraction;
}
