// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ClosedRange } from "../../math/closed-range.ts";
import type { Tile } from "../tile.ts";
import type { Center } from "./visible-content-state.ts";

/** A column and row of the target zoom's grid. */
export interface GridCell {
  readonly x: number;
  readonly y: number;
}

/**
 * The ring rules' grid measure read off the sphere: how many rings of target
 * tiles lie between the look-at tile and a tile of any zoom. The count is the
 * plane's (`FlatRingRuleCoverage`: ring 0 the look-at tile alone, ring 1 the
 * three by three around it), with the two things the sphere's grid does that
 * the plane's does not. The columns close on themselves at the antimeridian,
 * so a column's distance is the shorter way around, where the plane reaches
 * into the next world copy. The rows end at the poles, so a ring that runs
 * off the last row is cut there.
 */
export const GlobeRingMath = {
  /**
   * The target zoom's tile under the point the camera looks at, from the
   * frame's fractional centre (`TileCulling.makeCenter`), which the globe's
   * pan brings to the sphere's front point.
   */
  lookAtTile(center: Center, targetZoom: number): GridCell {
    const tilesCount = 2 ** Math.max(targetZoom, 0);
    const clamp = (value: number) => Math.min(Math.max(Math.floor(value), 0), tilesCount - 1);
    return { x: clamp(center.tileX), y: clamp(center.tileY) };
  },

  /** The rings of the nearest and the farthest target tile under `tile`, a tile at or above the target zoom. */
  ringRange(tile: Tile, targetZoom: number, lookAt: GridCell): ClosedRange {
    const shift = Math.max(targetZoom - tile.z, 0);
    const tilesCount = 2 ** Math.max(targetZoom, 0);
    const span = 2 ** shift;
    const firstColumn = tile.x * span;
    const firstRow = tile.y * span;
    const rows = GlobeRingMath.axisRange(firstRow, span, lookAt.y);
    const columns = GlobeRingMath.wrappedAxisRange(firstColumn, span, lookAt.x, tilesCount);
    return {
      lowerBound: Math.max(rows.lowerBound, columns.lowerBound),
      upperBound: Math.max(rows.upperBound, columns.upperBound),
    };
  },

  /** The distances from `lookAt` to the nearest and the farthest of `count` cells starting at `first`, on an axis with ends. */
  axisRange(first: number, count: number, lookAt: number): ClosedRange {
    const last = first + count - 1;
    const nearest = lookAt < first ? first - lookAt : lookAt > last ? lookAt - last : 0;
    return { lowerBound: nearest, upperBound: Math.max(Math.abs(lookAt - first), Math.abs(lookAt - last)) };
  },

  /** The same on an axis of `tilesCount` cells that closes on itself: a cell's distance is the shorter way around. */
  wrappedAxisRange(first: number, count: number, lookAt: number, tilesCount: number): ClosedRange {
    if (!(count < tilesCount)) return { lowerBound: 0, upperBound: Math.trunc(tilesCount / 2) };
    // The look-at cell's offset past the block's first cell, going up the
    // axis. Inside the block it is under `count`.
    const offset = (((lookAt - first) % tilesCount) + tilesCount) % tilesCount;
    if (offset < count) {
      // The block never reaches half way around: it is a power of two cells
      // of a power of two axis, under the whole of it.
      return { lowerBound: 0, upperBound: Math.max(offset, count - 1 - offset) };
    }
    // Outside: going up the axis the block's cells are `nearestUp` to
    // `offset` steps behind the look-at cell, and a cell that many steps
    // behind is the shorter of that and the rest of the way around.
    const nearestUp = offset - (count - 1);
    const nearest = Math.min(nearestUp, tilesCount - offset);
    // The farthest is the cell nearest the antipode: half way around when
    // the antipode is inside the block, otherwise the block's end on the
    // antipode's side.
    const half = Math.trunc(tilesCount / 2);
    let farthest: number;
    if (nearestUp <= half && half <= offset) farthest = half;
    else if (offset < half) farthest = offset;
    else farthest = tilesCount - nearestUp;
    return { lowerBound: nearest, upperBound: farthest };
  },
} as const;
