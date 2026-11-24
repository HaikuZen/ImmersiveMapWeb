// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { LayerPickMath, type LayerPickPlace, type World } from "../layers/selection/layer-pick-math.ts";
import { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { type GeoScreenProjectionFrameConstants, GeoScreenProjectionMath, makeScreenPointOutput } from "./geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

const scratch = makeScreenPointOutput();

/**
 * From a pixel of the screen to the place on the map under it, by the
 * projection a frame drew with, the Swift `GeoScreenPlaceMath`. Shared by
 * every feature that tests a tap against the ground (the layers of the
 * app's data, the tile grid). The search itself is `LayerPickMath.place`.
 *
 * The world is the Web-Mercator one: x east and y south, 0 to 1 across the
 * world.
 */
export const GeoScreenPlaceMath = {
  /** The place under `pixel` (drawable pixels, origin bottom-left), the search starting where the camera looks. `undefined` when the pixel is not on the map. */
  place(pixel: readonly [number, number], projection: GeoScreenProjectionFrameConstants): LayerPickPlace | undefined {
    return LayerPickMath.place(pixel, GeoScreenPlaceMath.centre(projection), (world) => GeoScreenPlaceMath.project(world, projection));
  },

  /** The world position the camera looks at, where the search for a tap's place starts. */
  centre(projection: GeoScreenProjectionFrameConstants): World {
    if (projection.mode === "flat") return ImmersiveMapProjection.centerWorldMercatorFromFlatPan(projection.flatPan);
    return ImmersiveMapProjection.centerWorldMercatorFromGlobePan([projection.globe.panX, projection.globe.panY]);
  },

  /** The pixel a world position is drawn at, `undefined` where the map does not show it. */
  project(world: World, projection: GeoScreenProjectionFrameConstants): readonly [number, number] | undefined {
    const coordinate = LayerPickMath.coordinateOfWorld(world);
    const output = GeoScreenProjectionMath.project(GeoProjectionBasis.fromCoordinate(coordinate), projection, scratch);
    if (output.visible === 0 || !(output.visibilityAlpha > 0) || !Number.isFinite(output.positionX) || !Number.isFinite(output.positionY)) return undefined;
    return [output.positionX, output.positionY];
  },
} as const;
