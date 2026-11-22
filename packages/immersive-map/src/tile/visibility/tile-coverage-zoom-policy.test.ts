// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileCoverageZoomPolicyTests`.

import { describe, expect, test } from "vitest";
import { TileCoverageZoomPolicy } from "./tile-coverage-zoom-policy.ts";

describe("TileCoverageZoomPolicy", () => {
  test("flat mode keeps a single coverage zoom at the floored camera zoom", () => {
    expect(TileCoverageZoomPolicy.resolve(1.74, "flat", 20).baseZoom).toBe(1);
  });

  test("globe mode keeps a single coverage zoom at the floored camera zoom", () => {
    expect(TileCoverageZoomPolicy.resolve(1.74, "spherical", 20).baseZoom).toBe(1);
  });

  test("globe mode does not request an ahead detail zoom near the maximum zoom", () => {
    expect(TileCoverageZoomPolicy.resolve(19.7, "spherical", 20).baseZoom).toBe(19);
  });

  test("the globe does not create a duplicate detail zoom when the base is already at the maximum", () => {
    expect(TileCoverageZoomPolicy.resolve(20.0, "spherical", 20).baseZoom).toBe(20);
  });
});
