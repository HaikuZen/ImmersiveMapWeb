// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `HorizonBackdropTests`: the world tile under every
// placement, once per world copy, flat, a small texture without lines or
// labels.

import { describe, expect, test } from "vitest";
import { inOwnSlot, makePlaceTile, type ResidentTile, type VisibleTile } from "../placement/place-tile.ts";
import { tileKey } from "../tile.ts";
import { TileWorkingSet } from "./working-set.ts";

const v = (x: number, y: number, z: number, worldWrap = 0): VisibleTile => ({ tile: { x, y, z }, worldWrap });

describe("TileWorkingSet.horizonBackdrops", () => {
  test("the backdrop is the world tile once per world copy", () => {
    const world: ResidentTile = { tile: TileWorkingSet.horizonBackdropTile };
    const targets = [v(3, 2, 4, 0), v(15, 2, 4, -1), v(4, 2, 4, 0)];
    const backdrops = TileWorkingSet.horizonBackdrops(targets, new Map([[tileKey(world.tile), world]]));

    expect(backdrops.map((b) => b.placeIn)).toEqual([v(0, 0, 0, -1), v(0, 0, 0, 0)]);
    for (const backdrop of backdrops) {
      expect(backdrop.isHorizonBackdrop).toBe(true);
      expect(inOwnSlot(backdrop)).toBe(true);
      expect(backdrop.rules.drawsLines).toBe(false);
      expect(backdrop.rules.drawsLabels).toBe(false);
      expect(backdrop.rules.raster?.size).toBe(TileWorkingSet.horizonBackdropRasterSize);
    }
    expect(TileWorkingSet.horizonBackdropTile).toEqual({ x: 0, y: 0, z: 0 });
    expect(TileWorkingSet.horizonBackdrops(targets, new Map()), "nothing while the world tile is not resident").toEqual([]);
    expect(makePlaceTile(world, { tile: world.tile, worldWrap: 0 }).isHorizonBackdrop, "a placement is the backdrop only when placed as one").toBe(false);
  });
});
