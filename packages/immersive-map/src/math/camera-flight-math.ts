// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraBearingConstraintResolver } from "../camera/camera-constraint-resolver.ts";
import type { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec2, Vec3 } from "./vec.ts";

const deltaEpsilon = 1e-9;
const greatCircleAngleEpsilon = 1e-6;

/** One point of an overview flight. */
export interface OverviewFlightSample {
  /** Progress of the camera center along the route in [0, 1]. */
  readonly panProgress: number;
  readonly zoom: number;
}

/**
 * Arc steepness: the larger, the higher the apex. 1.42 is the value from the
 * original paper, and Mapbox flyTo uses the same one.
 */
const rho = 1.42;
const distanceEpsilon = 1e-9;

/**
 * The "climb, cruise, dive" zoom-and-pan trajectory after van Wijk and Nuij
 * ("Smooth and efficient zooming and panning", 2003). The apex altitude grows
 * with flight distance up to a globe view, and pan speed is tied to altitude:
 * near the ground the camera crawls, at the apex it covers most of the
 * distance.
 */
export class OverviewFlightProfile {
  private constructor(
    private readonly startVisibleSpan: number,
    private readonly routeDistance: number,
    private readonly startR: number,
    private readonly totalS: number,
    private readonly coshStartR: number,
    private readonly sinhStartR: number,
  ) {}

  /**
   * Returns null for degenerate flights (no horizontal displacement), where
   * the trajectory coincides with direct zoom interpolation.
   */
  static make(startZoom: number, targetZoom: number, normalizedWorldDistance: number): OverviewFlightProfile | null {
    const routeDistance = normalizedWorldDistance;
    if (!Number.isFinite(routeDistance) || !(routeDistance > distanceEpsilon)) {
      return null;
    }

    // Visible world width w = 2^-zoom: units are consistent with the world
    // distance, and the viewport constant does not affect the arc shape.
    const startSpan = 2.0 ** -startZoom;
    const targetSpan = 2.0 ** -targetZoom;
    const rhoSquared = rho * rho;
    const spanDelta = targetSpan * targetSpan - startSpan * startSpan;
    const arcTerm = rhoSquared * rhoSquared * routeDistance * routeDistance;
    const b0 = (spanDelta + arcTerm) / (2.0 * startSpan * rhoSquared * routeDistance);
    const b1 = (spanDelta - arcTerm) / (2.0 * targetSpan * rhoSquared * routeDistance);
    // r(b) = ln(sqrt(b^2 + 1) - b) = -asinh(b), and asinh is numerically more stable.
    const startR = -Math.asinh(b0);
    const targetR = -Math.asinh(b1);
    const totalS = (targetR - startR) / rho;
    if (!Number.isFinite(totalS) || !(totalS > 0)) {
      return null;
    }

    return new OverviewFlightProfile(startSpan, routeDistance, startR, totalS, Math.cosh(startR), Math.sinh(startR));
  }

  sample(progress: number): OverviewFlightSample {
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    const x = rho * clampedProgress * this.totalS + this.startR;
    const traveled = (this.startVisibleSpan / (rho * rho)) * (this.coshStartR * Math.tanh(x) - this.sinhStartR);
    const visibleSpan = (this.startVisibleSpan * this.coshStartR) / Math.cosh(x);
    return {
      panProgress: Math.min(Math.max(traveled / this.routeDistance, 0), 1),
      zoom: -Math.log2(visibleSpan),
    };
  }
}

/** The interpolation a camera flight is made of. */
export const CameraFlightMath = {
  minimumDuration: 0.001,

  easeInOutCubic(progress: number): number {
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    if (clampedProgress < 0.5) {
      return 4 * clampedProgress * clampedProgress * clampedProgress;
    }
    const invertedProgress = -2 * clampedProgress + 2;
    return 1 - (invertedProgress * invertedProgress * invertedProgress) / 2;
  },

  shortestWrappedWorldDelta(start: number, end: number): number {
    let delta = end - start;
    if (delta > 0.5) {
      delta -= 1.0;
    } else if (delta < -0.5) {
      delta += 1.0;
    }
    return delta;
  },

  interpolateWrappedWorldX(start: number, end: number, progress: number): number {
    return ImmersiveMapProjection.wrapNormalizedWorldX(start + CameraFlightMath.shortestWrappedWorldDelta(start, end) * progress);
  },

  shortestBearingDelta(start: number, end: number): number {
    const normalizedStart = CameraBearingConstraintResolver.normalized(start);
    const normalizedEnd = CameraBearingConstraintResolver.normalized(end);
    let delta = normalizedEnd - normalizedStart;
    if (delta > Math.PI) {
      delta -= 2 * Math.PI;
    } else if (delta < -Math.PI) {
      delta += 2 * Math.PI;
    }
    return delta;
  },

  interpolateBearing(start: number, end: number, progress: number): number {
    const normalizedStart = CameraBearingConstraintResolver.normalized(start);
    const delta = CameraFlightMath.shortestBearingDelta(start, end);
    return CameraBearingConstraintResolver.normalized(normalizedStart + delta * progress);
  },

  hasMeaningfulDelta(start: ImmersiveMapCameraState, end: ImmersiveMapCameraState): boolean {
    return (
      Math.abs(CameraFlightMath.shortestWrappedWorldDelta(start.centerWorldMercator[0], end.centerWorldMercator[0])) > deltaEpsilon ||
      Math.abs(end.centerWorldMercator[1] - start.centerWorldMercator[1]) > deltaEpsilon ||
      Math.abs(end.zoom - start.zoom) > deltaEpsilon ||
      Math.abs(CameraFlightMath.shortestBearingDelta(start.bearing, end.bearing)) > deltaEpsilon ||
      Math.abs(end.pitch - start.pitch) > deltaEpsilon
    );
  },

  mercatorCenter(start: Vec2, end: Vec2, progress: number): Vec2 {
    return [CameraFlightMath.interpolateWrappedWorldX(start[0], end[0], progress), start[1] + (end[1] - start[1]) * progress];
  },

  /**
   * Route length along the shortest Mercator path in normalized world
   * coordinates (1.0 = one full revolution along x).
   */
  mercatorRouteDistance(start: Vec2, end: Vec2): number {
    const deltaX = CameraFlightMath.shortestWrappedWorldDelta(start[0], end[0]);
    return Math.hypot(deltaX, end[1] - start[1]);
  },

  /**
   * Route length along the great circle in the same units: a fraction of the
   * equatorial circumference (arc angle / 2 pi), so it is comparable to the
   * Mercator distance.
   */
  greatCircleRouteDistance(start: Vec2, end: Vec2): number {
    const startVector = normalizedCartesianOfWorld(start);
    const endVector = normalizedCartesianOfWorld(end);
    const dotProduct = Math.min(1.0, Math.max(-1.0, dot(startVector, endVector)));
    return Math.acos(dotProduct) / (2.0 * Math.PI);
  },

  /** The center a great-circle flight is at by `progress`, null for antipodal endpoints. */
  greatCircleCenter(start: Vec2, end: Vec2, progress: number): Vec2 | null {
    const startVector = normalizedCartesianOfWorld(start);
    const endVector = normalizedCartesianOfWorld(end);

    const dotProduct = Math.min(1.0, Math.max(-1.0, dot(startVector, endVector)));
    const angle = Math.acos(dotProduct);
    let interpolated: Vec3;
    if (angle < greatCircleAngleEpsilon) {
      interpolated = normalize([
        startVector[0] + (endVector[0] - startVector[0]) * progress,
        startVector[1] + (endVector[1] - startVector[1]) * progress,
        startVector[2] + (endVector[2] - startVector[2]) * progress,
      ]);
    } else if (Math.abs(Math.PI - angle) < greatCircleAngleEpsilon) {
      return null;
    } else {
      const sinAngle = Math.sin(angle);
      if (!(Math.abs(sinAngle) >= greatCircleAngleEpsilon)) {
        return null;
      }
      const startWeight = Math.sin((1 - progress) * angle) / sinAngle;
      const endWeight = Math.sin(progress * angle) / sinAngle;
      interpolated = normalize([
        startVector[0] * startWeight + endVector[0] * endWeight,
        startVector[1] * startWeight + endVector[1] * endWeight,
        startVector[2] * startWeight + endVector[2] * endWeight,
      ]);
    }

    const latitude = Math.asin(Math.max(-1.0, Math.min(1.0, interpolated[2])));
    const longitude = Math.atan2(interpolated[1], interpolated[0]);
    return ImmersiveMapProjection.worldMercator(latitude, longitude);
  },
} as const;

function normalizedCartesianOfWorld(world: Vec2): Vec3 {
  const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(world[1]);
  const longitude = ImmersiveMapProjection.longitudeFromNormalizedWorldX(world[0]);
  const cosLatitude = Math.cos(latitude);
  return normalize([cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3): Vec3 {
  const inverse = 1 / Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] * inverse, v[1] * inverse, v[2] * inverse];
}
