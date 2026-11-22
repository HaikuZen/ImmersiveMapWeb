// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GlobeLightSettings } from "../configuration/scene-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec3 } from "../math/vec.ts";
import type { GlobeUniform } from "./globe-uniform.ts";

/**
 * The globe's pan rotation and the sun fixed to the Earth, the parts of the
 * Swift `GlobeFrameConstantsUniform.rotationMatrix` and
 * `GlobeLightUniform.sunWorldDirection` the atmosphere and the starfield
 * read, and the globe surface's light (`GlobeLight`) reads.
 */
export const GlobeSunDirection = {
  /**
   * The pan rotation exactly as the shaders build it: four columns, in the
   * row-vector layout the shaders consume with `v * M` (WGSL's `vec4 * mat4`
   * is the same product as MSL's). Column-major, 16 numbers.
   */
  rotationMatrix(panLatitude: number, panLongitude: number): Float64Array {
    const cx = Math.cos(-panLatitude);
    const sx = Math.sin(-panLatitude);
    const cy = Math.cos(-panLongitude);
    const sy = Math.sin(-panLongitude);
    return Float64Array.of(cy, 0, -sy, 0, sy * sx, cx, cy * sx, 0, sy * cx, -sx, cy * cx, 0, 0, 0, 0, 1);
  },

  /** The pan rotation of a frame's globe. */
  globeRotationMatrix(globe: GlobeUniform): Float64Array {
    return GlobeSunDirection.rotationMatrix(globe.panY * ImmersiveMapProjection.maxMercatorLatitude, globe.panX * Math.PI);
  },

  /**
   * The unit earth-fixed direction of a point of the planet by its
   * geographic coordinate, in the frame the globe's vertices are projected
   * from: y the pole axis, z toward longitude 0, x toward 90 degrees east.
   */
  earthDirection(latitudeDegrees: number, longitudeDegrees: number): Vec3 {
    const latitude = (latitudeDegrees * Math.PI) / 180;
    const longitude = (longitudeDegrees * Math.PI) / 180;
    return [Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude)];
  },

  /**
   * The direction toward the sun in world space this frame: the sun over
   * the subsolar point, turned with the globe by its pan (the transposed
   * rotation, the turn the globe's vertices take), so the terminator and
   * the halo's day side lie on one part of the planet whichever way it is
   * turned. Unit length.
   */
  sunWorldDirection(settings: GlobeLightSettings, globe: GlobeUniform): Vec3 {
    const [ex, ey, ez] = GlobeSunDirection.earthDirection(settings.subsolarLatitudeDegrees, settings.subsolarLongitudeDegrees);
    const r = GlobeSunDirection.globeRotationMatrix(globe);
    // transpose(R) * v: each component is a column of R dotted with v.
    const x = r[0]! * ex + r[1]! * ey + r[2]! * ez;
    const y = r[4]! * ex + r[5]! * ey + r[6]! * ez;
    const z = r[8]! * ex + r[9]! * ey + r[10]! * ez;
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  },
} as const;
