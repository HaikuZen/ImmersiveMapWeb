// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { add3, length3, scale3, sub3, type Vec3 } from "../math/vec.ts";
import type { GeoCoordinate } from "./geo-coordinate.ts";

/**
 * Below this angle the two coordinates are the same point for every
 * practical purpose (about 6 mm on Earth) and the great circle through them
 * is undefined.
 */
const degenerateAngleRadians = 1e-9;
/**
 * Below this sine the endpoints are antipodal: the weights blow up and the
 * blended vector loses every significant bit to cancellation.
 */
const antipodalSineThreshold = 1e-7;

/**
 * Great-circle math: interpolation between coordinates, central angle and
 * forward azimuth. It lives in `geo` because the scene model animation needs
 * it too, and feature folders must not depend on each other.
 *
 * Everything is computed in double precision. The path sampler measures
 * segments a few kilometers long, where a `Float` dot product near 1 has no
 * significant bits left and the central angle degenerates to noise.
 */
export const GeoGreatCircleMath = {
  /**
   * Great-circle interpolation over unit vectors: correct near the
   * antimeridian and the poles, unlike a lat/lon lerp.
   */
  coordinate(start: GeoCoordinate, target: GeoCoordinate, progress: number): GeoCoordinate {
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    if (!(clampedProgress > 0)) {
      return start;
    }
    if (!(clampedProgress < 1)) {
      return target;
    }

    const fromVector = GeoGreatCircleMath.unitVector(start);
    const toVector = GeoGreatCircleMath.unitVector(target);
    const angle = GeoGreatCircleMath.centralAngleOfVectors(fromVector, toVector);
    if (!(angle > degenerateAngleRadians)) {
      return start;
    }

    const sinAngle = Math.sin(angle);
    if (!(sinAngle > antipodalSineThreshold)) {
      return antipodalCoordinate(start, target, clampedProgress);
    }

    const startWeight = Math.sin((1 - clampedProgress) * angle) / sinAngle;
    const targetWeight = Math.sin(clampedProgress * angle) / sinAngle;
    const blended = add3(scale3(fromVector, startWeight), scale3(toVector, targetWeight));
    return GeoGreatCircleMath.coordinateOfVector(blended);
  },

  /** Central angle of the arc, in radians. */
  centralAngle(start: GeoCoordinate, target: GeoCoordinate): number {
    return GeoGreatCircleMath.centralAngleOfVectors(GeoGreatCircleMath.unitVector(start), GeoGreatCircleMath.unitVector(target));
  },

  /**
   * Forward azimuth at `start`, clockwise from north, in degrees `[0, 360)`.
   * Degenerate (identical or antipodal endpoints) returns 0.
   */
  bearingDegrees(start: GeoCoordinate, target: GeoCoordinate): number {
    const startLatitude = (start.latitude * Math.PI) / 180.0;
    const targetLatitude = (target.latitude * Math.PI) / 180.0;
    const longitudeDelta = ((target.longitude - start.longitude) * Math.PI) / 180.0;

    const y = Math.sin(longitudeDelta) * Math.cos(targetLatitude);
    const x =
      Math.cos(startLatitude) * Math.sin(targetLatitude) - Math.sin(startLatitude) * Math.cos(targetLatitude) * Math.cos(longitudeDelta);
    if (x === 0 && y === 0) {
      return 0;
    }

    const bearing = (Math.atan2(y, x) * 180.0) / Math.PI;
    return (bearing + 360.0) % 360.0;
  },

  /**
   * Unit vector in the (x = cosLat*cosLon, y = cosLat*sinLon, z = sinLat)
   * frame. Not the globe shader frame of `GeoProjectionBasis.sphereUnit`:
   * this one only ever round-trips through `coordinateOfVector`.
   */
  unitVector(coordinate: GeoCoordinate): Vec3 {
    const latitude = (coordinate.latitude * Math.PI) / 180.0;
    const longitude = (coordinate.longitude * Math.PI) / 180.0;
    const cosLatitude = Math.cos(latitude);
    return [cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)];
  },

  /**
   * Half-chord form: accurate for the whole `[0, pi]` range, unlike
   * `acos(dot)`, which loses all precision for short arcs.
   */
  centralAngleOfVectors(fromVector: Vec3, toVector: Vec3): number {
    const chord = length3(sub3(fromVector, toVector));
    const opposite = length3(add3(fromVector, toVector));
    return 2.0 * Math.atan2(chord, opposite);
  },

  coordinateOfVector(vector: Vec3): GeoCoordinate {
    const inverseLength = 1 / length3(vector);
    const x = vector[0] * inverseLength;
    const y = vector[1] * inverseLength;
    const z = vector[2] * inverseLength;
    const latitude = Math.atan2(z, Math.sqrt(x * x + y * y));
    const longitude = Math.atan2(y, x);
    return { latitude: (latitude * 180.0) / Math.PI, longitude: (longitude * 180.0) / Math.PI };
  },

  normalizedLongitude(longitude: number): number {
    let normalized = longitude % 360;
    if (normalized > 180) {
      normalized -= 360;
    } else if (normalized < -180) {
      normalized += 360;
    }
    return normalized;
  },
} as const;

/**
 * Antipodal endpoints leave the great circle underdetermined, so this falls
 * back to a lat/lon lerp along the shortest longitude delta.
 */
function antipodalCoordinate(start: GeoCoordinate, target: GeoCoordinate, progress: number): GeoCoordinate {
  const latitude = start.latitude + (target.latitude - start.latitude) * progress;
  const longitudeDelta = shortestLongitudeDelta(start.longitude, target.longitude);
  const longitude = GeoGreatCircleMath.normalizedLongitude(start.longitude + longitudeDelta * progress);
  return { latitude, longitude };
}

function shortestLongitudeDelta(start: number, target: number): number {
  let delta = GeoGreatCircleMath.normalizedLongitude(target) - GeoGreatCircleMath.normalizedLongitude(start);
  if (delta > 180) {
    delta -= 360;
  } else if (delta < -180) {
    delta += 360;
  }
  return delta;
}
