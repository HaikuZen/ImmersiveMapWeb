// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileDemandPriorityMathTests`.

import { describe, expect, test } from "vitest";
import { type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import { TileDemandPriorityMath } from "./tile-demand-priority-math.ts";

const v = (x: number, y: number, z: number, worldWrap = 0): VisibleTile => ({ tile: { x, y, z }, worldWrap });

describe("TileDemandPriorityMath", () => {
  test("the flat sort puts tiles near the camera center first", () => {
    // Center in the middle of tile (2, 2) at z2: 4x4 world, center (0.625, 0.625).
    const nearTile = v(2, 2, 2);
    const sideTile = v(1, 2, 2);
    const farTile = v(0, 0, 2);
    const sorted = TileDemandPriorityMath.sortedByCameraProximity([farTile, sideTile, nearTile], [0.625, 0.625], "flat");
    expect(sorted).toEqual([nearTile, sideTile, farTile]);
  });

  test("the sort compares mixed zoom targets in world units", () => {
    // The far coarse target (z3) is geographically farther from the center
    // than the detailed near ones (z5): the normalized metric must not give
    // the coarse tile a head start due to its larger size.
    const nearDetailed = v(16, 16, 5);
    const nearbyDetailed = v(15, 16, 5);
    const farCoarse = v(1, 4, 3);
    const sorted = TileDemandPriorityMath.sortedByCameraProximity([farCoarse, nearbyDetailed, nearDetailed], [0.5, 0.5], "flat");
    expect(sorted.at(-1)).toEqual(farCoarse);
    expect(new Set(sorted.slice(0, 2).map(visibleTileKey))).toEqual(new Set([nearDetailed, nearbyDetailed].map(visibleTileKey)));
  });

  test("the flat sort respects the world wrap offset", () => {
    // Center near the world's right edge (x=0.9): the world copy 1 of tile
    // x=0 (world position 1.0625) is closer than its copy 0 (0.0625).
    const wrappedCopy = v(0, 2, 3, 1);
    const baseCopy = v(0, 2, 3, 0);
    expect(TileDemandPriorityMath.sortedByCameraProximity([baseCopy, wrappedCopy], [0.9, 0.5], "flat")).toEqual([wrappedCopy, baseCopy]);
  });

  test("the spherical sort wraps around the antimeridian", () => {
    // Center near the antimeridian (x=0.98): tile x=0 at z3 (center 0.0625)
    // is closer through the wrap (0.1) than a tile in mid-world (0.5,
    // distance 0.42).
    const acrossAntimeridian = v(0, 4, 3);
    const midWorld = v(4, 4, 3);
    expect(TileDemandPriorityMath.sortedByCameraProximity([midWorld, acrossAntimeridian], [0.98, 0.5], "spherical")).toEqual([acrossAntimeridian, midWorld]);
  });

  test("the sort is deterministic for equal distances", () => {
    // Four tiles symmetric around the center: equal distances, the order
    // must be stable (world wrap, x, y) from call to call.
    const tiles = [v(4, 3, 3), v(3, 4, 3), v(3, 3, 3), v(4, 4, 3)];
    const once = TileDemandPriorityMath.sortedByCameraProximity(tiles, [0.5, 0.5], "flat");
    const twice = TileDemandPriorityMath.sortedByCameraProximity([...tiles].reverse(), [0.5, 0.5], "flat");
    expect(once).toEqual(twice);
  });
});
