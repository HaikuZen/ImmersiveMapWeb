// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ResidentTile } from "../placement/place-tile.ts";
import { type Tile, tileFromKey, tileKey, tileParentAt } from "../tile.ts";

/**
 * The world cover is pinned lazily: once materialized, tiles with z <= this
 * level are not released when they leave the demanded set, so the far zone
 * of a tilted camera and the globe's back side stay resident. The cover is
 * the one z0 tile, the whole world generalized to a single tile: the flat
 * map's horizon backdrop and the sphere's far field draw it
 * (`TileCulling.flatBackdropZoomLevel`, the sphere's floor zoom). A
 * memory warning still drops it when not currently demanded. It warms up
 * again from disk.
 */
export const pinnedWorldCoverMaxZoomLevel = 0;

/** What the store did, for a tile trace. The counts and bytes are the store's after the event. */
export type TileStoreTraceEvent =
  | { readonly kind: "insert"; readonly tile: Tile; readonly replaced: boolean; readonly residentCount: number; readonly residentBytes: number }
  | {
      readonly kind: "release";
      readonly tile: Tile;
      readonly reason: "not_demanded" | "memory_warning";
      readonly residentCount: number;
      readonly residentBytes: number;
    }
  | { readonly kind: "lookup"; readonly tile: Tile; readonly hit: boolean; readonly residentCount: number; readonly residentBytes: number }
  | { readonly kind: "removeAll"; readonly removedCount: number; readonly removedBytes: number };

export interface TileWorkingSetStoreOptions<R extends ResidentTile> {
  /**
   * What one tile holds in GPU memory, in bytes: the buffers and textures
   * the caller allocated for it. 0 when left out.
   */
  readonly byteSize?: (resident: R) => number;
  /** Receives every insert, release, lookup and clear, for a tile trace. */
  readonly trace?: (event: TileStoreTraceEvent) => void;
}

const noTiles: ReadonlySet<string> = new Set<string>();

/**
 * The tiles resident in GPU memory. Membership is a function of the present,
 * nothing is carried from one frame to the next: the frame's demanded set
 * (the coverage targets and the horizon backdrop), the pinned world cover
 * below, and the tiles that stand in for a demanded target that has not
 * arrived yet. A tile the demand stopped naming stays while it is such a
 * stand-in and leaves the moment it is not:
 *
 * - a descendant of a loading target, at any depth: a zoom-out keeps the
 *   detailed tiles the camera was just looking at until their ancestor lands
 *   on top of them, however far the zoom has run ahead of the loads;
 * - the finest resident ancestor of a loading target: a zoom-in keeps the
 *   parent until every child that replaces it has landed.
 *
 * Those are exactly the tiles `buildPlacements` would draw for the target,
 * so nothing is kept that the frame cannot show, and nothing the frame shows
 * is released under it, not even by a memory warning. There is no retention
 * beyond that: a tile the camera left comes back from the prepared disk
 * cache.
 *
 * The GPU work is the caller's: a resident tile is any `R`, and releasing
 * one only drops the store's reference to it. WebGPU keeps a buffer a
 * submitted command buffer reads alive until the work completes, so a
 * release never frees what the GPU still reads.
 */
export class TileWorkingSetStore<R extends ResidentTile> {
  static readonly pinnedWorldCoverMaxZoomLevel = pinnedWorldCoverMaxZoomLevel;

  private readonly byteSize: (resident: R) => number;
  private readonly trace: ((event: TileStoreTraceEvent) => void) | undefined;
  private readonly residents = new Map<string, R>();
  private readonly byteCounts = new Map<string, number>();
  /** The frame's demanded set, by `tileKey`. */
  private readonly demandedTiles = new Map<string, Tile>();
  private mutationVersion = 0;
  private residentBytes = 0;
  /**
   * The tiles the last frame's placements drew (`updateDemandedTiles`), by
   * `tileKey`: kept while the demand does not name them, as the planner
   * shows them on until their targets land.
   */
  private shownTiles: ReadonlySet<string> = noTiles;
  /**
   * Scratch for `updateDemandedTiles`, kept across calls so the steady state
   * allocates no collection: the ancestors kept this pass, and the tiles to
   * release.
   */
  private readonly keptAncestors = new Set<string>();
  private readonly releaseScratch: string[] = [];

  constructor(options: TileWorkingSetStoreOptions<R> = {}) {
    this.byteSize = options.byteSize ?? (() => 0);
    this.trace = options.trace;
  }

  /**
   * Changes on every mutation that can affect a demanded tile's readiness:
   * insert, memory-warning release, full clear. Together with the coverage
   * version it forms the demand pipeline's dirty-gate key. Releases
   * performed by `updateDemandedTiles` do not bump it: they touch only tiles
   * the demand pass that triggered them already stopped asking about, so
   * re-running that pass would change nothing.
   */
  get contentVersion(): number {
    return this.mutationVersion;
  }

  /** Diagnostics: how many tiles are resident right now. */
  get residentTileCount(): number {
    return this.residents.size;
  }

  /** Diagnostics: what the resident tiles hold in bytes (`TileWorkingSetStoreOptions.byteSize`). */
  get residentByteCount(): number {
    return this.residentBytes;
  }

  /**
   * The frame's demanded set. Every resident tile above the pinned world
   * cover that the set does not name and that stands in for none of the
   * set's loading tiles is released here, synchronously: this is the one
   * release path in the steady state. Decided from the set and the residency
   * alone, the order carries no meaning here. `shown` is what the last
   * frame's placements drew, by `tileKey`: kept while the planner keeps
   * showing it. The store holds on to `shown` until the next call.
   */
  updateDemandedTiles(orderedTiles: readonly Tile[], shown: ReadonlySet<string> = noTiles): void {
    this.demandedTiles.clear();
    for (const tile of orderedTiles) this.demandedTiles.set(tileKey(tile), tile);
    this.shownTiles = shown;
    this.collectReleasable(false);
    for (const key of this.releaseScratch) this.release(key);
    this.traceReleases("not_demanded");
  }

  /**
   * Fills `releaseScratch` with the resident tiles the frame has no use for:
   * not demanded, and standing in for no loading tile. The pinned world
   * cover is spared unless asked for, and even then a cover tile standing in
   * (the sphere draws the cover under a loading target) stays.
   */
  private collectReleasable(pinnedCoverToo: boolean): void {
    // The finest resident ancestor of every loading target is what the
    // placement draws under it until it lands. The walk stops above the
    // cover while the cover is not in question: it is never released then,
    // so marking it would be work for nothing.
    const ancestorFloorZoom = pinnedCoverToo ? 0 : pinnedWorldCoverMaxZoomLevel + 1;
    this.keptAncestors.clear();
    for (const [key, target] of this.demandedTiles) {
      if (this.residents.has(key) || !(target.z > ancestorFloorZoom)) continue;
      let ancestor = target;
      while (ancestor.z > ancestorFloorZoom) {
        const parent = tileParentAt(ancestor, ancestor.z - 1);
        if (parent === undefined) break;
        ancestor = parent;
        const ancestorKey = tileKey(ancestor);
        if (this.residents.has(ancestorKey)) {
          this.keptAncestors.add(ancestorKey);
          break;
        }
      }
    }

    this.releaseScratch.length = 0;
    for (const [key, resident] of this.residents) {
      if (this.demandedTiles.has(key)) continue;
      if (resident.tile.z <= pinnedWorldCoverMaxZoomLevel && !pinnedCoverToo) continue;
      // What the last frame showed stays while the planner keeps showing it
      // (`buildPlacements`): the ground keeps its tiles until the target
      // lands.
      if (this.shownTiles.has(key) || this.keptAncestors.has(key) || this.standsInBelowALoadingTarget(resident.tile)) continue;
      this.releaseScratch.push(key);
    }
  }

  /**
   * Whether a resident tile is a descendant, at any depth, of a demanded
   * tile that is not resident: what the placement draws in the target's
   * place until it lands.
   */
  private standsInBelowALoadingTarget(tile: Tile): boolean {
    let ancestor = tile;
    while (ancestor.z > 0) {
      const parent = tileParentAt(ancestor, ancestor.z - 1);
      if (parent === undefined) break;
      ancestor = parent;
      const key = tileKey(ancestor);
      if (this.demandedTiles.has(key)) return !this.residents.has(key);
    }
    return false;
  }

  /**
   * Every resident tile, the stand-ins included, by `tileKey`: what the
   * placement planner builds a frame from. The store's own map, read only,
   * and changed by the store's next mutation.
   */
  residentTiles(): ReadonlyMap<string, R> {
    return this.residents;
  }

  /**
   * Always stores, a key outside the demanded set included: the loader
   * finishes what it started, and a tile that lands after the camera has
   * moved on is released by the next `updateDemandedTiles`. Offscreen
   * harnesses rely on the same grace period when they parse tiles before any
   * frame has demanded them.
   */
  insert(resident: R, key: Tile = resident.tile): void {
    const byteCount = this.byteSize(resident);
    const stringKey = tileKey(key);
    const replacedBytes = this.byteCounts.get(stringKey);
    this.residents.set(stringKey, resident);
    this.byteCounts.set(stringKey, byteCount);
    this.residentBytes = Math.max(0, this.residentBytes + byteCount - (replacedBytes ?? 0));
    this.mutationVersion += 1;
    this.trace?.({
      kind: "insert",
      tile: key,
      replaced: replacedBytes !== undefined,
      residentCount: this.residents.size,
      residentBytes: this.residentBytes,
    });
  }

  /** Residency without the lookup trace, for the per-frame checks that would drown the log with a trace event each. */
  contains(key: Tile): boolean {
    return this.residents.has(tileKey(key));
  }

  /** The resident tile under `key`, traced as a lookup. */
  get(key: Tile): R | undefined {
    const resident = this.residents.get(tileKey(key));
    this.trace?.({ kind: "lookup", tile: key, hit: resident !== undefined, residentCount: this.residents.size, residentBytes: this.residentBytes });
    return resident;
  }

  /**
   * The memory-warning response: hands back the pinned world cover outside
   * the current demand, which is the one thing the steady state keeps beyond
   * the frame's needs. What the frame draws, the demanded tiles and the
   * stand-ins under the loading ones, stays: a warning must not blank the
   * screen it arrives on. The cover warms up again lazily from the prepared
   * disk cache.
   */
  releaseUndemandedTiles(): void {
    this.collectReleasable(true);
    for (const key of this.releaseScratch) this.release(key);
    if (this.releaseScratch.length > 0) this.mutationVersion += 1;
    this.traceReleases("memory_warning");
  }

  removeAll(): void {
    const removedCount = this.residents.size;
    const removedBytes = this.residentBytes;
    this.residents.clear();
    this.byteCounts.clear();
    this.residentBytes = 0;
    this.mutationVersion += 1;
    this.trace?.({ kind: "removeAll", removedCount, removedBytes });
  }

  private release(key: string): void {
    const bytes = this.byteCounts.get(key);
    if (bytes === undefined) return;
    this.residents.delete(key);
    this.byteCounts.delete(key);
    this.residentBytes = Math.max(0, this.residentBytes - bytes);
  }

  private traceReleases(reason: "not_demanded" | "memory_warning"): void {
    const trace = this.trace;
    if (trace === undefined) return;
    for (const key of this.releaseScratch) {
      trace({ kind: "release", tile: tileFromKey(key), reason, residentCount: this.residents.size, residentBytes: this.residentBytes });
    }
  }
}
