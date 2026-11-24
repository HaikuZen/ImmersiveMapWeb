// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "./geo-coordinate.ts";

/**
 * A box of latitude and longitude, in degrees, by its south-west and its
 * north-east corners, the Swift `ImmersiveMapGeoBounds`. A north-east
 * longitude west of the south-west one spans the antimeridian: from 170 to
 * -170 is the 20 degrees across the 180th meridian, not the 340 the other
 * way round. Plain data.
 */
export interface ImmersiveMapGeoBounds {
  readonly southWest: GeoCoordinate;
  readonly northEast: GeoCoordinate;
}

type Span = readonly [number, number];

/** A longitude within -180..<180. */
function wrapped(longitude: number): number {
  if (longitude >= -180 && longitude < 180) return longitude;
  if (longitude === 180) return 180;
  const turn = (longitude + 180) % 360;
  return (turn < 0 ? turn + 360 : turn) - 180;
}

/** The longitudes of the box within -180...180: one span, or two for a box across the antimeridian. */
function longitudeSpans(bounds: ImmersiveMapGeoBounds): Span[] {
  // A box written as the whole turn or more is the whole turn.
  if (bounds.northEast.longitude - bounds.southWest.longitude >= 360) return [[-180, 180]];
  const west = wrapped(bounds.southWest.longitude);
  let east = wrapped(bounds.northEast.longitude);
  // An east edge on the antimeridian is written 180 and wraps to -180.
  if (east === -180 && bounds.northEast.longitude > bounds.southWest.longitude) east = 180;
  if (west <= east) return [[west, east]];
  return [
    [west, 180],
    [-180, east],
  ];
}

export const ImmersiveMapGeoBounds = {
  make(southWest: GeoCoordinate, northEast: GeoCoordinate): ImmersiveMapGeoBounds {
    return { southWest: { latitude: southWest.latitude, longitude: southWest.longitude }, northEast: { latitude: northEast.latitude, longitude: northEast.longitude } };
  },

  /** Whether the box holds the coordinate, its edges included. */
  contains(bounds: ImmersiveMapGeoBounds, coordinate: GeoCoordinate): boolean {
    if (!(coordinate.latitude >= bounds.southWest.latitude && coordinate.latitude <= bounds.northEast.latitude)) return false;
    const longitude = wrapped(coordinate.longitude);
    return longitudeSpans(bounds).some(([west, east]) => longitude >= west && longitude <= east);
  },

  /** Whether the two boxes have a point in common, their edges included. */
  intersects(bounds: ImmersiveMapGeoBounds, other: ImmersiveMapGeoBounds): boolean {
    if (!(bounds.southWest.latitude <= other.northEast.latitude && other.southWest.latitude <= bounds.northEast.latitude)) return false;
    const others = longitudeSpans(other);
    return longitudeSpans(bounds).some((span) => others.some((o) => span[0] <= o[1] && o[0] <= span[1]));
  },

  /**
   * Whether the two boxes share an area, more than an edge or a corner: a
   * tile beside a box drawn along its edge does not overlap it.
   */
  overlaps(bounds: ImmersiveMapGeoBounds, other: ImmersiveMapGeoBounds): boolean {
    if (!(bounds.southWest.latitude < other.northEast.latitude && other.southWest.latitude < bounds.northEast.latitude)) return false;
    const others = longitudeSpans(other);
    return longitudeSpans(bounds).some((span) => others.some((o) => span[0] < o[1] && o[0] < span[1]));
  },
} as const;
