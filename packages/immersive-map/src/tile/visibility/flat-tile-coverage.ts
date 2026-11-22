// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { VisibleTile } from "../placement/place-tile.ts";
import type { CoveragePolygon } from "./coverage-polygon.ts";

const worldWraps: readonly number[] = [-1, 0, 1];

/** A count the enumeration adds the tiles it looked at to, for the diagnostics. */
export interface VisitCounter {
  count: number;
}

function compareByWrapAndPosition(lhs: VisibleTile, rhs: VisibleTile): number {
  if (lhs.worldWrap !== rhs.worldWrap) return lhs.worldWrap - rhs.worldWrap;
  if (lhs.tile.x !== rhs.tile.x) return lhs.tile.x - rhs.tile.x;
  return lhs.tile.y - rhs.tile.y;
}

/** Whether the polygon meets the tile's square in world units. */
function squareMeets(x: number, y: number, z: number, worldWrap: number, flatRenderState: FlatRenderState, polygon: CoveragePolygon): boolean {
  const origin = ImmersiveMapProjection.flatTileOriginAndSize(x, y, z, worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
  return polygon.intersects(origin[0], origin[1], origin[0] + origin[2], origin[1] + origin[2]);
}

/**
 * The flat map's tile enumeration: the tiles of one zoom under a polygon of
 * the plane, every world copy, in a deterministic order. The ring rules
 * (`FlatRingRuleCoverage`) enumerate each band's ground with it.
 */
export const FlatTileCoverage = {
  /**
   * The tiles at `zoom` the polygon meets, every world copy, in a
   * deterministic order (by world copy, column, row). `visited`, when given,
   * counts the tiles looked at.
   */
  tiles(zoom: number, polygon: CoveragePolygon, flatRenderState: FlatRenderState, visited?: VisitCounter): VisibleTile[] {
    if (zoom < 0) return [];
    const tiles: VisibleTile[] = [];
    let count = 0;
    const visit = (x: number, y: number, z: number, worldWrap: number): void => {
      count += 1;
      if (!squareMeets(x, y, z, worldWrap, flatRenderState, polygon)) return;
      if (z === zoom) {
        tiles.push({ tile: { x, y, z }, worldWrap });
        return;
      }
      const childX = x * 2;
      const childY = y * 2;
      const childZ = z + 1;
      visit(childX, childY, childZ, worldWrap);
      visit(childX + 1, childY, childZ, worldWrap);
      visit(childX, childY + 1, childZ, worldWrap);
      visit(childX + 1, childY + 1, childZ, worldWrap);
    };
    for (const worldWrap of worldWraps) visit(0, 0, 0, worldWrap);
    if (visited !== undefined) visited.count += count;
    return tiles.sort(compareByWrapAndPosition);
  },

  /** Renderer-stable order: finest first, then by world copy and position. Sorts a copy. */
  sorted(targets: readonly VisibleTile[]): VisibleTile[] {
    return [...targets].sort(FlatTileCoverage.compare);
  },

  /** The comparator of `sorted`. */
  compare(lhs: VisibleTile, rhs: VisibleTile): number {
    if (lhs.tile.z !== rhs.tile.z) return rhs.tile.z - lhs.tile.z;
    return compareByWrapAndPosition(lhs, rhs);
  },
} as const;
