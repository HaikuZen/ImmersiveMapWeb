// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** Geographic coordinate in degrees: latitude and longitude. */
export interface GeoCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export function geoCoordinate(latitude: number, longitude: number): GeoCoordinate {
  return { latitude, longitude };
}

export function geoCoordinatesEqual(a: GeoCoordinate, b: GeoCoordinate): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}
