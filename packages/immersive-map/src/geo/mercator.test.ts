// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { lonLatToWorld, MAX_LATITUDE, worldToLonLat } from "./mercator.ts";

describe("mercator", () => {
  test("the origin and the corners", () => {
    expect(lonLatToWorld(0, 0)).toEqual([0.5, 0.5]);
    const [x0, y0] = lonLatToWorld(-180, MAX_LATITUDE);
    expect(x0).toBe(0);
    expect(y0).toBeCloseTo(0, 9);
  });

  test("round trip", () => {
    for (const [lon, lat] of [
      [37.6175, 55.752],
      [-74.011, 40.715],
      [151.2, -33.87],
    ] as const) {
      const [x, y] = lonLatToWorld(lon, lat);
      const [lon2, lat2] = worldToLonLat(x, y);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });
});
