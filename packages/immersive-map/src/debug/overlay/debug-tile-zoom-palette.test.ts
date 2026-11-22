// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugTileZoomPaletteTests`.

import { describe, expect, test } from "vitest";
import { DebugTileZoomPalette } from "./debug-tile-zoom-palette.ts";

describe("DebugTileZoomPalette", () => {
  test("a zoom always takes the same bright colour", () => {
    for (let zoom = 0; zoom <= 20; zoom++) {
      const color = DebugTileZoomPalette.color(zoom);
      expect(DebugTileZoomPalette.color(zoom)).toEqual(color);
      // Full brightness, for the black stroke on a dark map.
      expect(Math.max(...color)).toBeCloseTo(1, 6);
      expect(Math.min(...color)).toBeGreaterThanOrEqual(0);
    }
  });

  test("neighbouring zooms are far apart", () => {
    for (let zoom = 0; zoom <= 19; zoom++) {
      const a = DebugTileZoomPalette.color(zoom);
      const b = DebugTileZoomPalette.color(zoom + 1);
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      expect(distance, `z${zoom} and z${zoom + 1} must not look alike`).toBeGreaterThan(0.5);
    }
  });

  test("the hue wheel is the usual one", () => {
    expect(DebugTileZoomPalette.rgb(0, 1, 1)).toEqual([1, 0, 0]);
    expect(DebugTileZoomPalette.rgb(1 / 3, 1, 1)).toEqual([0, 1, 0]);
    expect(DebugTileZoomPalette.rgb(2 / 3, 1, 1)).toEqual([0, 0, 1]);
  });
});
