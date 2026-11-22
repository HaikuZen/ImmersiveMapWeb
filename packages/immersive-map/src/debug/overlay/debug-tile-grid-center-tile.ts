// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { VisibleTile } from "../../tile/placement/place-tile.ts";

/** What the pick reads of a placement: the slot it is drawn in. */
export interface DebugTileGridPlacement {
  readonly placeIn: VisibleTile;
}

/**
 * Picks the one tile the debug grid draws on (the Swift
 * `DebugTileGridCenterTile`): the tile under the camera centre, which is the
 * map point at the middle of the view.
 */
export const DebugTileGridCenterTile = {
  /**
   * Placed tiles whose slot contains the camera centre. `placeIn` slots are a
   * non-overlapping cover of the visible area, so this is a single tile per
   * wrapped world copy: on the flat map the same tile can be on screen more
   * than once, and every copy contains the centre equally.
   */
  candidates<P extends DebugTileGridPlacement>(placeTiles: readonly P[], centerWorldMercator: Vec2): P[] {
    const worldX = ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]);
    // The southern edge belongs to the last row rather than to a row that
    // does not exist, so a centre clamped exactly to 1.0 still lands on a tile.
    const worldY = Math.min(ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]), 1.0 - Number.EPSILON);
    return placeTiles.filter((placeTile) => {
      const zoom = placeTile.placeIn.tile.z;
      if (!(zoom >= 0 && zoom < 30)) return false;
      const tilesCount = 2 ** zoom;
      const rawX = worldX * tilesCount - placeTile.placeIn.tile.x;
      const wrappedX = rawX - tilesCount * Math.floor(rawX / tilesCount);
      const localY = worldY * tilesCount - placeTile.placeIn.tile.y;
      return wrappedX >= 0.0 && wrappedX < 1.0 && localY >= 0.0 && localY < 1.0;
    });
  },

  /**
   * Tie-break between wrapped copies: the copy drawn closest to the middle of
   * the viewport is the one the camera is actually looking at.
   * `projectedCenters` holds the screen position of each candidate's UV
   * centre, in the same order.
   */
  nearestToViewportCenter<P>(candidates: readonly P[], projectedCenters: readonly ScreenPointOutput[], viewportSize: Vec2): P | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length < 2 || projectedCenters.length !== candidates.length) return candidates[0];
    const centerX = viewportSize[0] * 0.5;
    const centerY = viewportSize[1] * 0.5;
    let best: P | undefined;
    let bestDistance = Number.MAX_VALUE;
    for (let index = 0; index < candidates.length; index++) {
      const point = projectedCenters[index]!;
      if (point.visible === 0) continue;
      const distance = Math.hypot(point.positionX - centerX, point.positionY - centerY);
      if (!Number.isFinite(distance) || !(distance < bestDistance)) continue;
      bestDistance = distance;
      best = candidates[index];
    }
    return best ?? candidates[0];
  },
} as const;
