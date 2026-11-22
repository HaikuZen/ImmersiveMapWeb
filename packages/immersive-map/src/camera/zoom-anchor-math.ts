// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec2 } from "../math/vec.ts";
import { GlobeCameraProximity } from "./globe-camera-proximity.ts";
import { SurfaceScaleMath } from "./surface-scale-math.ts";

export interface ZoomAnchorInput {
  /** Gesture point in view coordinates (top-left origin, CSS pixels). */
  readonly anchorPoint: Vec2;
  /** View size in CSS pixels, width and height. */
  readonly viewportSize: Vec2;
  readonly centerWorldMercator: Vec2;
  readonly zoomBefore: number;
  readonly zoomAfter: number;
  readonly bearing: number;
  /** Globe-to-flat phase before the zoom: 0 is globe, 1 is flat. */
  readonly transitionBefore: number;
  /** Globe-to-flat phase after the zoom. */
  readonly transitionAfter: number;
  readonly globeRadiusScale: number;
  /** Compensation fraction: 0 zooms into the screen center, 1 keeps the point under the cursor fixed. */
  readonly anchorFactor: number;
}

/** tan(fov/2) for the fov pi/4 of `RenderCamera.recalculateProjection`. */
const halfFovTangent = Math.tan(Math.PI / 8.0);

/**
 * Computes the map-center compensation for anchored zoom: the world point
 * under the cursor (the gesture point) stays put on screen, so the camera
 * pulls toward the cursor when zooming in and away from it when zooming out.
 *
 * The screen model mirrors the renderer: a perspective camera with fov pi/4
 * at distance `1 - 0.5 frac(zoom)` times the globe proximity
 * (`GlobeCameraProximity`) and a world of size
 * `2 pi globeRadiusScale 2^floor(zoom)` (`RenderCameraPoseResolver` and
 * `PresentationStateResolver`). In the globe phase the sphere locally
 * compresses the world near the screen center by `cos(latitude)`, so a
 * linear approximation is used: anchoring is approximate near the globe
 * edges. Camera tilt (pitch) is not modeled.
 */
export const ZoomAnchorMath = {
  compensatedCenterWorldMercator(input: ZoomAnchorInput): Vec2 {
    const width = input.viewportSize[0];
    const height = input.viewportSize[1];
    const center = input.centerWorldMercator;
    if (!(width > 0) || !(height > 0) || !(input.anchorFactor > 0) || input.zoomBefore === input.zoomAfter) {
      return center;
    }

    // Anchor offset from the screen center. The screen Y axis (down) is
    // converted to the render axis (up).
    const anchorX = input.anchorPoint[0] - width * 0.5;
    const anchorY = height * 0.5 - input.anchorPoint[1];
    if (anchorX === 0 && anchorY === 0) {
      return center;
    }

    // Screen axes to world render axes: the camera is rotated by bearing
    // around Z, so the world vector under screen offset p equals R(bearing) p.
    const cosBearing = Math.cos(input.bearing);
    const sinBearing = Math.sin(input.bearing);
    const worldDirectionX = anchorX * cosBearing - anchorY * sinBearing;
    const worldDirectionY = anchorX * sinBearing + anchorY * cosBearing;

    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]);
    const unitsPerPointBefore = normalizedWorldUnitsPerPoint(input.zoomBefore, input.transitionBefore, latitude, height, input.globeRadiusScale);
    const unitsPerPointAfter = normalizedWorldUnitsPerPoint(input.zoomAfter, input.transitionAfter, latitude, height, input.globeRadiusScale);
    const unitsPerPointDelta = unitsPerPointBefore - unitsPerPointAfter;
    if (!Number.isFinite(unitsPerPointDelta) || unitsPerPointDelta === 0) {
      return center;
    }

    // World point under the anchor: w = c + (q worldDirection.x,
    // -q worldDirection.y), since normalized world Y grows southward and
    // render Y grows northward. Requiring w(before) = w(after) yields the
    // center shift.
    const shift = unitsPerPointDelta * input.anchorFactor;
    return [
      ImmersiveMapProjection.wrapNormalizedWorldX(center[0] + worldDirectionX * shift),
      ImmersiveMapProjection.clampNormalizedWorldY(center[1] - worldDirectionY * shift),
    ];
  },
} as const;

/**
 * Normalized-world units per screen point along the horizontal at the screen
 * center: q(z) = 2 d(z) proximity tan(fov/2) / (H mapSize(z) surfaceScale).
 * `surfaceScale` is the local surface scale at the centre (cos(lat) on the
 * sphere, 1 on the plane, the morph's curve between) and `proximity` the
 * camera's globe move-in by that same scale, so once the move-in is fully
 * active the two cancel and the globe zooms like the plane.
 */
function normalizedWorldUnitsPerPoint(zoom: number, transition: number, latitude: number, viewportHeight: number, globeRadiusScale: number): number {
  const cameraDistance = 1.0 - 0.5 * (zoom % 1.0);
  const proximity = GlobeCameraProximity.distanceFactor(latitude, transition, zoom);
  const renderMapSize = 2.0 * Math.PI * globeRadiusScale * 2.0 ** Math.floor(zoom);
  const surfaceScale = SurfaceScaleMath.surfaceScale(latitude, transition);
  return (2.0 * cameraDistance * proximity * halfFovTangent) / (viewportHeight * renderMapSize * surfaceScale);
}
