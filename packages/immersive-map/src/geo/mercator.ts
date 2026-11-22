// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** Web Mercator in the unit square: x east, y south, both in [0, 1]. */

export const MAX_LATITUDE = 85.051128779806604;

export function lonLatToWorld(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const phi = (clamped * Math.PI) / 180;
  const x = (lon + 180) / 360;
  const y = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return [x, y];
}

export function worldToLonLat(x: number, y: number): [number, number] {
  const lon = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lon, lat];
}
