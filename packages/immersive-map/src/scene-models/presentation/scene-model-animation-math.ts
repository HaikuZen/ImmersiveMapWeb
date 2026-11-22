// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { type Quat, quatFromAngleAxis, quatMultiply, quatSlerp, quatToMat3 } from "../../math/quaternion.ts";

/** Heading, pitch and roll of an orientation, in degrees. */
export interface SceneModelOrientationAngles {
  readonly headingDegrees: number;
  readonly pitchDegrees: number;
  readonly rollDegrees: number;
}

const degreesToRadians = Math.PI / 180;

/**
 * Deterministic animation math for scene models, a port of the Swift
 * `SceneModelAnimationMath`: move durations, quaternion orientation, and
 * scalar easing. Kept inside the scene models so the folder does not depend
 * on the pins. Great-circle interpolation itself lives in
 * `GeoGreatCircleMath`.
 */
export const SceneModelAnimationMath = Object.freeze({
  minimumPositionDuration: 0.14,
  maximumPositionDuration: 0.6,
  saturationDistanceMeters: 250,
  minimumAnimatedDistanceMeters: 0.01,

  /**
   * Move duration in seconds scaled by the geodesic distance: short hops
   * stay snappy, long jumps saturate instead of dragging on.
   */
  positionAnimationDuration(start: GeoCoordinate, target: GeoCoordinate): number {
    const distance = geodesicDistanceMeters(start, target);
    if (!(distance > SceneModelAnimationMath.minimumAnimatedDistanceMeters)) return 0;
    const normalized = Math.min(Math.max(distance / SceneModelAnimationMath.saturationDistanceMeters, 0), 1);
    const eased = normalized ** 0.6;
    const { minimumPositionDuration, maximumPositionDuration } = SceneModelAnimationMath;
    return minimumPositionDuration + (maximumPositionDuration - minimumPositionDuration) * eased;
  },

  /** Cubic ease-out of a raw progress, clamped to 0...1. */
  easedProgress(rawProgress: number): number {
    const clamped = Math.min(Math.max(rawProgress, 0), 1);
    const inverse = 1 - clamped;
    return 1 - inverse * inverse * inverse;
  },

  /**
   * Orientation in the anchor's tangent frame (east = +X, north = +Y,
   * up = +Z): heading is clockwise from north about up, then pitch about
   * east, then roll about the model's forward axis. Matches the matrix
   * product Rz(-heading) * Rx(pitch) * Ry(roll).
   */
  orientationQuaternion(headingDegrees: number, pitchDegrees: number, rollDegrees: number): Quat {
    const heading = quatFromAngleAxis(-headingDegrees * degreesToRadians, [0, 0, 1]);
    const pitch = quatFromAngleAxis(pitchDegrees * degreesToRadians, [1, 0, 0]);
    const roll = quatFromAngleAxis(rollDegrees * degreesToRadians, [0, 1, 0]);
    return quatMultiply(quatMultiply(heading, pitch), roll);
  },

  /**
   * Inverse of `orientationQuaternion`: recovers heading, pitch and roll
   * from an orientation in the anchor's tangent frame. Needed to tell the
   * controller where a path animation left a model, since the store carries
   * the displayed orientation as a quaternion.
   */
  orientationAngles(orientation: Quat): SceneModelOrientationAngles {
    // Column-major: matrix.columns.c[r] is m[c * 3 + r].
    const m = quatToMat3(orientation);
    // Rz(-heading) * Rx(pitch) * Ry(roll), so row 2 of column 1 is sin(pitch).
    const sinPitch = Math.min(Math.max(m[5]!, -1), 1);
    const pitch = Math.asin(sinPitch);
    const cosPitch = Math.sqrt(Math.max(0, 1 - sinPitch * sinPitch));

    let heading: number;
    let roll: number;
    if (cosPitch > 1e-5) {
      heading = -Math.atan2(-m[3]!, m[4]!);
      roll = Math.atan2(-m[2]!, m[8]!);
    } else {
      // Gimbal lock at +-90 degrees of pitch: heading and roll turn about
      // the same axis, so the whole turn is reported as heading.
      heading = -Math.atan2(m[1]!, m[0]!);
      roll = 0;
    }

    const degrees = 180 / Math.PI;
    return { headingDegrees: heading * degrees, pitchDegrees: pitch * degrees, rollDegrees: roll * degrees };
  },

  /** Shortest-arc quaternion interpolation. */
  orientation(start: Quat, target: Quat, progress: number): Quat {
    const clamped = Math.min(Math.max(progress, 0), 1);
    if (!(clamped > 0)) return start;
    if (!(clamped < 1)) return target;
    return quatSlerp(start, target, clamped);
  },

  scalar(start: number, target: number, progress: number): number {
    const clamped = Math.min(Math.max(progress, 0), 1);
    return start + (target - start) * clamped;
  },
});

function geodesicDistanceMeters(start: GeoCoordinate, target: GeoCoordinate): number {
  const latitude1 = start.latitude * degreesToRadians;
  const latitude2 = target.latitude * degreesToRadians;
  const sinLatitude = Math.sin((latitude2 - latitude1) * 0.5);
  const sinLongitude = Math.sin((target.longitude - start.longitude) * degreesToRadians * 0.5);
  const a = sinLatitude * sinLatitude + Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
