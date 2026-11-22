// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec2 } from "./vec.ts";

/**
 * Stateless math for a camera chasing a point that moves along a path.
 *
 * Unlike the pitch and bearing followers, the target here never stops
 * moving, so there is no snap or stall termination: the traversal ends on
 * its own when the duration runs out. The catch-up is the same
 * time-normalized exponential decay, which keeps the step independent of the
 * frame rate.
 */
export const CameraPathFollowMath = {
  /**
   * A frame longer than this (a stall, a resumed park) must not teleport the
   * camera. The step is capped instead.
   */
  maximumDeltaTime: 0.05,

  clampedDeltaTime(deltaTime: number): number {
    if (!Number.isFinite(deltaTime)) {
      return 0;
    }
    return Math.min(Math.max(0, deltaTime), CameraPathFollowMath.maximumDeltaTime);
  },

  /**
   * Fraction of the remaining gap closed in one step of `deltaTime`. A
   * non-positive half-life pins the camera rigidly to the target.
   *
   * `capsDeltaTime: false` is for the frame that ends a traversal: capping
   * there would leave the camera stranded wherever a stalled frame loop
   * happened to drop it, while reporting that the traversal succeeded. The
   * uncapped step owes exactly the catch-up the stall skipped.
   */
  catchUpFraction(deltaTime: number, halfLife: number, capsDeltaTime = true): number {
    if (!Number.isFinite(halfLife) || !(halfLife > 0)) {
      return 1;
    }
    const step = capsDeltaTime ? CameraPathFollowMath.clampedDeltaTime(deltaTime) : Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0);
    return 1 - Math.exp((-Math.log(2.0) * step) / halfLife);
  },

  /**
   * Shortest signed delta in normalized world X, where 1 is a whole world: a
   * camera near the antimeridian must chase across the seam, not the long way
   * around the globe.
   */
  shortestNormalizedWorldXDelta(current: number, target: number): number {
    let delta = (target - current) % 1;
    if (delta > 0.5) {
      delta -= 1;
    } else if (delta < -0.5) {
      delta += 1;
    }
    return delta;
  },

  /**
   * Steps the camera center toward the target in normalized world Mercator.
   * X takes the shortest way around the seam and stays wrapped. Y is a plain
   * decay, since Mercator Y does not wrap.
   */
  steppedCenter(current: Vec2, target: Vec2, catchUpFraction: number): Vec2 {
    const fraction = Math.min(Math.max(catchUpFraction, 0), 1);
    const deltaX = CameraPathFollowMath.shortestNormalizedWorldXDelta(current[0], target[0]);
    const x = ImmersiveMapProjection.wrapNormalizedWorldX(current[0] + deltaX * fraction);
    const y = ImmersiveMapProjection.clampNormalizedWorldY(current[1] + (target[1] - current[1]) * fraction);
    return [x, y];
  },

  /** Steps a scalar (zoom, pitch) toward its target with the same decay. */
  steppedScalar(current: number, target: number, catchUpFraction: number): number {
    const fraction = Math.min(Math.max(catchUpFraction, 0), 1);
    return current + (target - current) * fraction;
  },

  /** World-Mercator center of a coordinate, the space the camera state uses. */
  centerWorldMercator(coordinate: GeoCoordinate): Vec2 {
    return ImmersiveMapProjection.worldMercator((coordinate.latitude * Math.PI) / 180.0, (coordinate.longitude * Math.PI) / 180.0);
  },
} as const;
