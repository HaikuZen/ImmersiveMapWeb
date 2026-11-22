// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../../camera/view-mode.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { VisibleTile } from "../placement/place-tile.ts";

/**
 * Network demand order for tiles: from those closest to the camera center to
 * the far ones. The loader and the parse queue preserve the given order, so
 * this sort alone determines which tiles hit the network first and which one
 * gets a parse slot first. The metric is the Chebyshev distance in
 * normalized world coordinates: comparable across targets of different zooms
 * (distance LOD yields mixed z).
 */
export const TileDemandPriorityMath = {
  sortedByCameraProximity(targets: readonly VisibleTile[], centerWorldMercator: Vec2, renderSurfaceMode: ViewMode): VisibleTile[] {
    const wrappedCenterX = ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]);
    const clampedCenterY = ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]);
    const spherical = renderSurfaceMode === "spherical";

    const normalizedDistance = (target: VisibleTile): number => {
      const tilesCount = 2 ** target.tile.z;
      const tileCenterX = (target.tile.x + 0.5) / tilesCount;
      const tileCenterY = (target.tile.y + 0.5) / tilesCount;
      let dx: number;
      if (spherical) {
        const direct = Math.abs(wrappedCenterX - tileCenterX);
        dx = Math.min(direct, 1.0 - direct);
      } else {
        dx = Math.abs(wrappedCenterX - (tileCenterX + target.worldWrap));
      }
      const dy = Math.abs(clampedCenterY - tileCenterY);
      return Math.max(dx, dy);
    };

    return targets
      .map((target) => ({ target, distance: normalizedDistance(target) }))
      .sort((lhs, rhs) => {
        if (lhs.distance !== rhs.distance) return lhs.distance - rhs.distance;
        const left = lhs.target;
        const right = rhs.target;
        if (left.tile.z !== right.tile.z) return right.tile.z - left.tile.z;
        if (left.worldWrap !== right.worldWrap) return left.worldWrap - right.worldWrap;
        if (left.tile.x !== right.tile.x) return left.tile.x - right.tile.x;
        return left.tile.y - right.tile.y;
      })
      .map((entry) => entry.target);
  },
} as const;
