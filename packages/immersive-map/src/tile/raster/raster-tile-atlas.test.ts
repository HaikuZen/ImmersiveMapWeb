// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { grownRasterAtlasSize, rasterAtlasPages } from "./raster-tile-atlas.ts";

describe("rasterAtlasPages", () => {
  test("nothing to draw, no page", () => {
    expect(rasterAtlasPages([], 8192)).toEqual([]);
  });

  test("the windows are a square grid of cells as large as the largest texture", () => {
    const [page, ...rest] = rasterAtlasPages([64, 128, 64, 64, 128], 8192);
    expect(rest).toEqual([]);
    // Five windows: three columns, two rows of 128.
    expect(page!.width).toBe(384);
    expect(page!.height).toBe(256);
    expect(page!.windows).toEqual([
      { index: 0, x: 0, y: 0, size: 64 },
      { index: 1, x: 128, y: 0, size: 128 },
      { index: 2, x: 256, y: 0, size: 64 },
      { index: 3, x: 0, y: 128, size: 64 },
      { index: 4, x: 128, y: 128, size: 128 },
    ]);
  });

  test("past the side the device allows the windows go in pages, none overlapping", () => {
    const sizes = Array.from({ length: 10 }, () => 256);
    const pages = rasterAtlasPages(sizes, 512);
    expect(pages.map((p) => p.windows.length)).toEqual([4, 4, 2]);
    expect(pages.flatMap((p) => p.windows.map((w) => w.index))).toEqual([...sizes.keys()]);
    for (const page of pages) {
      expect(page.width).toBeLessThanOrEqual(512);
      expect(page.height).toBeLessThanOrEqual(512);
      const corners = new Set(page.windows.map((w) => `${w.x},${w.y}`));
      expect(corners.size).toBe(page.windows.length);
    }
  });
});

describe("grownRasterAtlasSize", () => {
  test("the atlas grows to the largest need, side by side, and stays when it fits", () => {
    expect(grownRasterAtlasSize(undefined, 256, 128)).toEqual({ width: 256, height: 128 });
    expect(grownRasterAtlasSize({ width: 256, height: 128 }, 128, 128)).toBeUndefined();
    expect(grownRasterAtlasSize({ width: 256, height: 128 }, 128, 512)).toEqual({ width: 256, height: 512 });
  });
});
