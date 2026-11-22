// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the `PlacementGroundSquare` parts of the Swift
// `GroundReliefShadowCasterTests` (the terrain texture test there needs
// Metal and the relief, and is not ported).

import { describe, expect, test } from "vitest";
import { type Tile, tileKey, tileParentAt } from "../tile.ts";
import { makePlaceTile, type ResidentTile } from "./place-tile.ts";
import { PlacementGroundSquare } from "./placement-ground-squares.ts";

function placement(source: Tile, placeIn: Tile, slot: number, terrain?: Tile) {
  const slotTile = tileParentAt(placeIn, Math.min(slot, placeIn.z)) ?? placeIn;
  return makePlaceTile<ResidentTile>({ tile: source }, { tile: placeIn, worldWrap: 0 }, { slot: { tile: slotTile, worldWrap: 0 }, terrain });
}

const same = (a: Tile, b: Tile) => tileKey(a) === tileKey(b);

describe("PlacementGroundSquare", () => {
  test("a coarser placement casts the squares the finer one leaves", () => {
    const parent = placement({ x: 2, y: 3, z: 8 }, { x: 2, y: 3, z: 8 }, 8);
    const child = placement({ x: 9, y: 13, z: 10 }, { x: 9, y: 13, z: 10 }, 10);
    const casters = PlacementGroundSquare.squares([parent, child]);
    const parentSquares = new Set(casters.filter((c) => same(c.source.tile, parent.resident.tile)).map((c) => tileKey(c.square.tile)));
    expect(parentSquares, "the parent casts the largest squares that hold no finer placement").toEqual(
      new Set(["9/5/6", "9/4/7", "9/5/7", "10/8/12", "10/9/12", "10/8/13"]),
    );
    expect(
      casters.filter((c) => same(c.source.tile, child.resident.tile)).map((c) => c.square.tile),
      "the finer placement casts its own square",
    ).toEqual([child.placeIn.tile]);
  });

  test("a placement sharing a square casts once", () => {
    const first = placement({ x: 4, y: 6, z: 9 }, { x: 8, y: 12, z: 10 }, 10);
    const last = placement({ x: 8, y: 12, z: 10 }, { x: 8, y: 12, z: 10 }, 10);
    const casters = PlacementGroundSquare.squares([first, last]);
    expect(casters.map((c) => c.source.tile), "the last mark of a square is the one the stencil keeps").toEqual([last.resident.tile]);
  });

  test("a source rises by the finest terrain it is placed with", () => {
    const source: Tile = { x: 4, y: 6, z: 9 };
    const fine: Tile = { x: 4, y: 6, z: 9 };
    const coarse: Tile = { x: 2, y: 3, z: 8 };
    const near = placement(source, { x: 8, y: 12, z: 10 }, 10, fine);
    const far = placement(source, { x: 9, y: 12, z: 10 }, 9, coarse);
    const casters = PlacementGroundSquare.squares([near, far]);
    expect(
      new Set(casters.map((c) => (c.source.displacement === undefined ? "none" : tileKey(c.source.displacement)))),
      "as the ground draws it, the source takes the finest terrain of its placements",
    ).toEqual(new Set([tileKey(fine)]));
  });

  test("a square takes its source's cells over its part", () => {
    expect(PlacementGroundSquare.cells(256, 8, 8)).toBe(256);
    expect(PlacementGroundSquare.cells(256, 8, 10)).toBe(64);
    expect(PlacementGroundSquare.cells(2, 8, 12)).toBe(1);
  });
});
