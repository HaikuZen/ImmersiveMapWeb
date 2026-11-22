// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileWorkingSetReliefLookTests`: how a tile parsed in
// layers draws on the relief (`TileWorkingSet.drawingOnTheRelief`), a texture
// without lines, except a stand-in that was on the screen as geometry the
// frame before and rises by no terrain, which keeps its look.

import { describe, expect, test } from "vitest";
import { makePlaceTile } from "../placement/place-tile.ts";
import { type Tile, tileKey } from "../tile.ts";
import { TileWorkingSet, type WorkingSetTile } from "./working-set.ts";

const parent: Tile = { x: 17, y: 11, z: 5 };
const child: Tile = { x: 34, y: 22, z: 6 };
const layeredTile = (tile: Tile): WorkingSetTile => ({ tile, groundIsFlattened: false, keepsBuildingsByQuarters: false });
const shownAsGeometry = new Set([tileKey(parent)]);

describe("TileWorkingSet.drawingOnTheRelief", () => {
  test("a stand-in shown as geometry keeps its geometry and lines", () => {
    const standIn = makePlaceTile(layeredTile(parent), { tile: child, worldWrap: 0 });
    const kept = TileWorkingSet.drawingOnTheRelief(standIn, shownAsGeometry);
    expect(kept.rules.raster, "drawn as it was shown").toBeUndefined();
    expect(kept.rules.drawsLines).toBe(true);
  });

  test("a stand-in not shown before draws as a texture without lines", () => {
    const standIn = makePlaceTile(layeredTile(parent), { tile: child, worldWrap: 0 });
    const converted = TileWorkingSet.drawingOnTheRelief(standIn, new Set());
    expect(converted.rules.raster?.size).toBe(TileWorkingSet.layeredTileRasterSize);
    expect(converted.rules.drawsLines).toBe(false);
  });

  test("a stand-in bound to a terrain draws as a texture", () => {
    const standIn = makePlaceTile(layeredTile(parent), { tile: child, worldWrap: 0 }, { terrain: parent });
    const converted = TileWorkingSet.drawingOnTheRelief(standIn, shownAsGeometry);
    expect(converted.rules.raster, "its square is marked raised, so it draws raised, from a texture").toBeDefined();
  });

  test("a tile in its own slot draws as a texture however it was shown", () => {
    const own = makePlaceTile(layeredTile(parent), { tile: parent, worldWrap: 0 });
    const converted = TileWorkingSet.drawingOnTheRelief(own, shownAsGeometry);
    expect(converted.rules.raster, "a ring drawn as geometry below the relief is a raised texture on it").toBeDefined();
  });

  test("a flattened tile draws as planned", () => {
    const flattened: WorkingSetTile = { tile: parent, groundIsFlattened: true, keepsBuildingsByQuarters: false };
    const placement = makePlaceTile(flattened, { tile: child, worldWrap: 0 });
    expect(TileWorkingSet.drawingOnTheRelief(placement, new Set())).toBe(placement);
  });
});
