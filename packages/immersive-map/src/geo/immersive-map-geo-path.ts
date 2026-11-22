// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "./geo-coordinate.ts";

/**
 * A trajectory over the globe: waypoints joined by great-circle arcs, plus an
 * altitude profile above the map surface.
 *
 * The same value describes the trajectory a 3D model flies along, so the
 * model is guaranteed to ride exactly on the line that is drawn.
 *
 * The path is parameterized by `fraction` in `0...1`, measured along arc
 * length: `0` is the first waypoint, `1` is the last one, and a waypoint in
 * the middle sits at its share of the total arc.
 */
export interface ImmersiveMapGeoPath {
  /**
   * Two or more coordinates. Fewer, or a path whose points all coincide,
   * draws nothing and animates nothing.
   */
  readonly waypoints: readonly GeoCoordinate[];
  /** Altitude held over the whole path, in meters above the map surface. */
  readonly baseAltitudeMeters: number;
  /**
   * Additional altitude at the middle of the path, in meters. The profile is
   * `base + peak * sin(pi * fraction)`: it starts and ends at `base` and
   * crests at `base + peak`, which is what makes a flight path arc away from
   * the globe and back.
   */
  readonly peakAltitudeMeters: number;
}

export interface GeoPathAltitudes {
  readonly baseAltitudeMeters?: number;
  readonly peakAltitudeMeters?: number;
}

export const ImmersiveMapGeoPath = {
  make(waypoints: readonly GeoCoordinate[], altitudes: GeoPathAltitudes = {}): ImmersiveMapGeoPath {
    return {
      waypoints,
      baseAltitudeMeters: altitudes.baseAltitudeMeters ?? 0,
      peakAltitudeMeters: altitudes.peakAltitudeMeters ?? 0,
    };
  },

  /** A path of one great-circle arc from `start` to `end`. */
  between(start: GeoCoordinate, end: GeoCoordinate, altitudes: GeoPathAltitudes = {}): ImmersiveMapGeoPath {
    return ImmersiveMapGeoPath.make([start, end], altitudes);
  },

  /** Altitude of the profile at `fraction`, in meters. */
  altitudeMeters(path: ImmersiveMapGeoPath, fraction: number): number {
    const clamped = Math.min(Math.max(fraction, 0), 1);
    if (path.peakAltitudeMeters === 0) {
      return path.baseAltitudeMeters;
    }
    return path.baseAltitudeMeters + path.peakAltitudeMeters * Math.sin(Math.PI * clamped);
  },
} as const;
