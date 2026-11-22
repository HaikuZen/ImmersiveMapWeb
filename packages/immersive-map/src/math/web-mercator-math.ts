// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

export const WebMercatorMath = {
  /** The latitude, in radians, where Web Mercator's square world ends: about 85.05 degrees. */
  maxLatitudeRadians: 2.0 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2.0,
} as const;
