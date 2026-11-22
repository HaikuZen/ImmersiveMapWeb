// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { tileIndex } from "../tile-index.ts";
import type { Tile } from "../tile.ts";

interface Entry {
  rise: number;
  quarters: number;
}

/**
 * How far the buildings drawn over a point of the map have risen this frame,
 * by the tile and the quarters they draw from (`BuildingCoveragePlanner`,
 * `PlaceTile.quarters`): what a label on a roof rises by. A label is asked
 * for by its own tile and its place in it, and the buildings over that place
 * may come from another zoom: a zoom 14 label over a quarter its zoom 15
 * child draws stands on the child's roofs, a zoom 15 label under a quarter
 * its parent draws on the parent's, and a label over a quarter nothing draws
 * stays on the ground. The coverage draws each point of the ground from one
 * tile at most, so the first drawn tile found over the point is the one.
 *
 * Keyed by `tileIndex`, so a label's lookup builds no key. A frame refills
 * one coverage (`clear`, then `add`) rather than making a new one.
 */
export class BuildingRiseCoverage {
  /** A coverage with nothing drawn, every rise 0. Never added to. */
  static readonly none = new BuildingRiseCoverage();

  private readonly entries = new Map<number, Entry>();
  private minimumZoom = Number.MAX_SAFE_INTEGER;
  private maximumZoom = Number.MIN_SAFE_INTEGER;

  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Forgets every tile, for the next frame's coverage. */
  clear(): void {
    this.entries.clear();
    this.minimumZoom = Number.MAX_SAFE_INTEGER;
    this.maximumZoom = Number.MIN_SAFE_INTEGER;
  }

  /**
   * Adds the buildings of `tile` drawn in `quarters`, risen by `rise`. A tile
   * drawn in two world copies keeps the higher rise and the quarters of both.
   */
  add(tile: Tile, quarters: number, rise: number): void {
    const key = tileIndex(tile.x, tile.y, tile.z);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.entries.set(key, { rise: Math.max(0, rise), quarters });
    } else {
      entry.rise = Math.max(entry.rise, rise);
      entry.quarters |= quarters;
    }
    this.minimumZoom = Math.min(this.minimumZoom, tile.z);
    this.maximumZoom = Math.max(this.maximumZoom, tile.z);
  }

  /** The rise of the buildings drawn at (`uvX`, `uvY`) of `tile` (x east, y from the north edge, both 0 to 1), 0 where none draw. */
  rise(tile: Tile, uvX: number, uvY: number): number {
    if (this.entries.size === 0) return 0;
    const u = Math.min(Math.max(uvX, 0), 1);
    const v = Math.min(Math.max(uvY, 0), 1);
    // The tile itself and the finer ones over the point.
    if (tile.z <= this.maximumZoom) {
      for (let depth = 0; depth <= this.maximumZoom - tile.z; depth++) {
        const scale = 2 ** depth;
        const offsetX = Math.min(Math.trunc(u * scale), scale - 1);
        const offsetY = Math.min(Math.trunc(v * scale), scale - 1);
        const rise = this.drawnRise(tile.x * scale + offsetX, tile.y * scale + offsetY, tile.z + depth, u * scale - offsetX, v * scale - offsetY);
        if (rise !== undefined) return rise;
      }
    }
    // The coarser ones under it.
    for (let zoom = Math.min(tile.z - 1, this.maximumZoom); zoom >= this.minimumZoom; zoom--) {
      const shift = tile.z - zoom;
      const scale = 2 ** shift;
      const coarseX = Math.floor(tile.x / scale);
      const coarseY = Math.floor(tile.y / scale);
      const coarseU = (tile.x - coarseX * scale + u) / scale;
      const coarseV = (tile.y - coarseY * scale + v) / scale;
      const rise = this.drawnRise(coarseX, coarseY, zoom, coarseU, coarseV);
      if (rise !== undefined) return rise;
    }
    return 0;
  }

  /** The rise of the tile when it draws the quarter at (`u`, `v`) of it. */
  private drawnRise(x: number, y: number, z: number, u: number, v: number): number | undefined {
    const entry = this.entries.get(tileIndex(x, y, z));
    if (entry === undefined) return undefined;
    const quarter = (v >= 0.5 ? 2 : 0) + (u >= 0.5 ? 1 : 0);
    return (entry.quarters & (1 << quarter)) !== 0 ? entry.rise : undefined;
  }
}
