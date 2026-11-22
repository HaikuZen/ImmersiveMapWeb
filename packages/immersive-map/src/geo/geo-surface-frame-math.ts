// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { GlobeUnrollMath } from "../globe/globe-unroll-math.ts";
import { mat4TransformInto } from "../math/matrix.ts";
import { cross3, mix3, normalize3, type Vec3 } from "../math/vec.ts";
import type { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { GeoScreenProjectionMath, type GeoScreenProjectionFrameConstants } from "./geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

/**
 * A geocoordinate resolved onto the (possibly mid-morph) map surface: the
 * world position, the local tangent frame, and how many render units one
 * ground meter spans there.
 */
export interface GeoSurfaceFrame {
  /**
   * Position on the surface itself. Altitude is applied by the caller as
   * `worldPosition + up * altitudeMeters * unitsPerMeter`.
   */
  readonly worldPosition: Vec3;
  /** Spherical position before the unfurl blend, kept for the horizon test. */
  readonly sphereWorldPosition: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
  readonly up: Vec3;
  readonly unitsPerMeter: number;
  /** Phase of the sphere-to-plane unroll, 0...1 (uniform across the surface: the unroll has no per-point wave). */
  readonly localTransition: number;
  /**
   * X of the flat morph target after unwrapping. Feed it back as the next
   * `flatWorldXReference` when resolving a chain of points, otherwise
   * neighbours straddling the antimeridian jump by a whole map width.
   */
  readonly flatWorldX: number;
  /**
   * False when the point is beyond the globe horizon gate. The depth test
   * would hide surface geometry anyway. This only lets callers skip a draw.
   */
  readonly passesHorizonGate: boolean;
}

/**
 * Mercator clamps at +-85.05 degrees, so the flat meter scale never divides
 * by a vanishing cos(latitude).
 */
const minimumCosLatitude = Math.cos(ImmersiveMapProjection.maxMercatorLatitude);

/**
 * CPU evaluation of the sphere-plane morph for a single geocoordinate:
 * position, blended tangent frame, and meter scale come from the same
 * formulas as `GeoScreenProjectionMath` (the CPU mirror of the globe
 * shaders), so anything anchored through this function sits exactly on the
 * morph geometry.
 *
 * Scene model anchors and their path animations resolve their positions
 * here, so a model rides exactly on the surface it is anchored to.
 */
export const GeoSurfaceFrameMath = {
  resolve(basis: GeoProjectionBasis, constants: GeoScreenProjectionFrameConstants, flatWorldXReference: number | null = null): GeoSurfaceFrame {
    const cosLatitude = Math.max(Math.hypot(basis.sphereUnit[0], basis.sphereUnit[2]), minimumCosLatitude);
    const earthCircumference = ImmersiveMapProjection.earthCircumferenceMeters;

    if (constants.mode === "flat") {
      // Mirror of GeoScreenProjectionMath's flat projection.
      const mapSize = constants.flatRenderMapSize;
      const halfMapSize = mapSize * 0.5;
      const wrappedX = ImmersiveMapProjection.wrap(basis.normalizedWorldX * mapSize - halfMapSize + constants.flatPan[0] * halfMapSize, mapSize);
      const xWorld = unwrapped(wrappedX, flatWorldXReference, mapSize);
      const yWorld = (basis.mercatorYNormalized - constants.flatPan[1]) * halfMapSize;
      const worldPosition: Vec3 = [xWorld, yWorld, 0];
      return {
        worldPosition,
        sphereWorldPosition: worldPosition,
        east: [1, 0, 0],
        north: [0, 1, 0],
        up: [0, 0, 1],
        unitsPerMeter: mapSize / (earthCircumference * cosLatitude),
        localTransition: 1,
        flatWorldX: xWorld,
        passesHorizonGate: true,
      };
    }

    // Mirror of GeoScreenProjectionMath's globe projection.
    const sphereWorldPosition = constants.rotatedSphereWorldPosition(basis.sphereUnit);
    const flat = constants.globeFlatWorldPosition(basis);
    const flatX = unwrapped(flat[0], flatWorldXReference, constants.globeMapSize);
    const flatY = flat[1];
    const transition = constants.globe.transition;
    const worldPosition =
      transition <= 0.0 ? sphereWorldPosition : GlobeUnrollMath.worldPosition(sphereWorldPosition, [flatX, flatY], transition, constants.globe.radius);

    // Tangent frame on the unit sphere (pre-rotation): up is the sphere
    // normal, east is d/dLongitude, degenerate exactly at the poles.
    const sphereUp = basis.sphereUnit;
    const eastRawX = sphereUp[2];
    const eastRawZ = -sphereUp[0];
    const eastLength = Math.hypot(eastRawX, eastRawZ);
    const sphereEast: Vec3 = eastLength > 1e-5 ? [eastRawX / eastLength, 0, eastRawZ / eastLength] : [1, 0, 0];
    const rotatedUp = rotateDirection(sphereUp, constants);
    const rotatedEast = rotateDirection(sphereEast, constants);

    // Blend toward the flat basis by the unroll phase and re-orthonormalize:
    // geometry tilts upright together with the surface it stands on.
    const up = normalize3(mix3(rotatedUp, [0, 0, 1], transition));
    const eastReference = normalize3(mix3(rotatedEast, [1, 0, 0], transition));
    const north = normalize3(cross3(up, eastReference));
    const east = cross3(north, up);

    // Meter scale: true ground meters on the sphere (2piR per Earth
    // circumference), inflating toward the Mercator 1/cos(latitude)
    // convention as the point unfurls into the plane.
    const sphereScale = (2 * Math.PI * constants.globe.radius) / earthCircumference;
    const flatScale = constants.globeMapSize / (earthCircumference * cosLatitude);
    const unitsPerMeter = sphereScale + (flatScale - sphereScale) * transition;

    const visibility = GeoScreenProjectionMath.globeVisibility(worldPosition, sphereWorldPosition, [flatX, flatY], constants);

    return {
      worldPosition,
      sphereWorldPosition,
      east,
      north,
      up,
      unitsPerMeter,
      localTransition: transition,
      flatWorldX: flatX,
      passesHorizonGate: visibility.visible && visibility.alpha > 0,
    };
  },
} as const;

/**
 * Brings `value` into the copy of the wrapped world nearest `reference`.
 * Both wraps (flat and globe-morph) fold X into one map width, which turns a
 * seam crossing into a full-width jump between neighbouring points.
 */
function unwrapped(value: number, reference: number | null, size: number): number {
  if (reference === null || !(size > 0)) {
    return value;
  }
  const halfSize = size * 0.5;
  let result = value;
  while (result - reference > halfSize) {
    result -= size;
  }
  while (reference - result > halfSize) {
    result += size;
  }
  return result;
}

const directionScratch = [0, 0, 0, 0];

/**
 * Applies the globe pan rotation to a direction, matching
 * `rotatedSphereWorldPosition` (w = 0: no translation).
 */
function rotateDirection(direction: Vec3, constants: GeoScreenProjectionFrameConstants): Vec3 {
  mat4TransformInto(directionScratch, constants.globeTransposedRotationMatrix, direction[0], direction[1], direction[2], 0);
  return [directionScratch[0]!, directionScratch[1]!, directionScratch[2]!];
}
