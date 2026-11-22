// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { GeoProjectionBasis } from "../../geo/geo-projection-basis.ts";
import { type GeoScreenProjectionFrameConstants, GeoScreenProjectionMath, makeScreenPointOutput, type ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { mat4TransformInto } from "../../math/matrix.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { VisibleTile } from "../../tile/placement/place-tile.ts";

const clipScratch = [0, 0, 0, 0];

/**
 * Points of a tile slot on screen for the debug overlay (the Swift
 * `TilePointScreenProjector` with `liftsByRelief` off): on the plane, not on
 * the relief, since the overlay is for reading. Drawable pixels, origin at
 * the bottom left, y up.
 *
 * On the flat map a point is placed from the slot's own origin
 * (`ImmersiveMapProjection.flatTileOriginAndSize`, the world copy
 * included), as the tiles draw, so every wrapped copy of a tile and a tile
 * across the antimeridian stay whole. On the globe and through the unroll
 * the tile UV becomes a geo basis and goes through `GeoScreenProjectionMath`,
 * which hides what the horizon or the unroll's cut hides.
 */
export class DebugOverlayTileProjector {
  readonly projection: GeoScreenProjectionFrameConstants;

  constructor(projection: GeoScreenProjectionFrameConstants) {
    this.projection = projection;
  }

  /** The point at `(u, v)` of the tile `placeIn`, `v` from the north edge. */
  project(placeIn: VisibleTile, u: number, v: number, out: ScreenPointOutput = makeScreenPointOutput()): ScreenPointOutput {
    const projection = this.projection;
    const tile = placeIn.tile;
    if (projection.mode === "flat") {
      const origin = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, placeIn.worldWrap, projection.flatPan, projection.flatRenderMapSize);
      const size = origin[2];
      // v grows from the north edge, the flat render world is y up.
      mat4TransformInto(clipScratch, projection.cameraUniform.matrix, origin[0] + u * size, origin[1] + (1.0 - v) * size, 0.0, 1.0);
      const w = clipScratch[3]!;
      if (!(w > 0.0)) {
        out.positionX = 0;
        out.positionY = 0;
        out.depth = 0;
        out.visible = 0;
        out.visibilityAlpha = 0;
        return out;
      }
      out.positionX = ((clipScratch[0]! / w) * 0.5 + 0.5) * projection.viewport[0];
      out.positionY = ((clipScratch[1]! / w) * 0.5 + 0.5) * projection.viewport[1];
      out.depth = clipScratch[2]! / w;
      out.visible = 1;
      out.visibilityAlpha = 1;
      return out;
    }
    const count = 2 ** tile.z;
    const worldU = (tile.x + u) / count;
    const worldV = (tile.y + v) / count;
    const latitude = Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * worldV)));
    const longitude = worldU * 2.0 * Math.PI - Math.PI;
    return GeoScreenProjectionMath.project(GeoProjectionBasis.fromRadians(latitude, longitude), projection, out);
  }

  /** Every point of `uvs` of the tile, in order. */
  projectAll(placeIn: VisibleTile, uvs: readonly Vec2[]): ScreenPointOutput[] {
    return uvs.map((uv) => this.project(placeIn, uv[0], uv[1]));
  }
}
