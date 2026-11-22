// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelSourceEntryTests` (the source entry part,
// the cache part is in base-label-cache.test.ts): one entry per owner tile
// whatever the slots it is placed in, exact sources before substitutes.

import { describe, expect, test } from "vitest";
import { makePlaceTile, type ResidentTile } from "../../tile/placement/place-tile.ts";
import { buildBaseLabelSourceEntries, sameSourceEntries } from "./base-label-source-entry.ts";

function resident(x: number, y: number, z: number): ResidentTile {
  return { tile: { x, y, z } };
}

function placeIn(x: number, y: number, z: number, worldWrap = 0) {
  return { tile: { x, y, z }, worldWrap };
}

describe("buildBaseLabelSourceEntries", () => {
  test("duplicate owner keys collapse to one entry", () => {
    const tile = resident(8, 8, 4);
    const near = makePlaceTile(tile, placeIn(32, 32, 6));
    const far = makePlaceTile(tile, placeIn(48, 48, 6));

    const nearFirst = buildBaseLabelSourceEntries([near, far]);
    const farFirst = buildBaseLabelSourceEntries([far, near]);

    expect(nearFirst).toHaveLength(1);
    expect(farFirst).toHaveLength(1);
    expect(sameSourceEntries(nearFirst, farFirst), "the order the slots come in does not change the source set").toBe(true);
  });

  test("a placement in its own slot wins over the same tile standing in", () => {
    const tile = resident(8, 8, 4);
    const entries = buildBaseLabelSourceEntries([makePlaceTile(tile, placeIn(32, 32, 6)), makePlaceTile(tile, placeIn(8, 8, 4))]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.inOwnSlot).toBe(true);
  });

  test("exact sources sort before substitutes, then by owner", () => {
    const lowerOwner = resident(8, 8, 4);
    const higherOwner = resident(9, 8, 4);
    const substitute = makePlaceTile(lowerOwner, placeIn(48, 48, 6));
    const exact = makePlaceTile(higherOwner, placeIn(9, 8, 4));

    const entries = buildBaseLabelSourceEntries([substitute, exact]);
    expect(
      entries.map((entry) => entry.ownerKey.tile.x),
      "the exact source leads, the substitute follows",
    ).toEqual([9, 8]);
    expect(sameSourceEntries(entries, buildBaseLabelSourceEntries([substitute]))).toBe(false);
  });

  test("among exact sources the finer tile leads, then x, y and the world copy", () => {
    const entries = buildBaseLabelSourceEntries([
      makePlaceTile(resident(1, 1, 2), placeIn(1, 1, 2, 1)),
      makePlaceTile(resident(1, 1, 2), placeIn(1, 1, 2, 0)),
      makePlaceTile(resident(0, 2, 2), placeIn(0, 2, 2)),
      makePlaceTile(resident(4, 4, 3), placeIn(4, 4, 3)),
    ]);
    expect(entries.map((entry) => `${entry.ownerKey.tile.z}/${entry.ownerKey.tile.x}/${entry.ownerKey.tile.y}@${entry.ownerKey.worldWrap}`)).toEqual(["3/4/4@0", "2/0/2@0", "2/1/1@0", "2/1/1@1"]);
  });

  test("a replaced resident is another source set", () => {
    const a = buildBaseLabelSourceEntries([makePlaceTile(resident(8, 8, 4), placeIn(8, 8, 4))]);
    const b = buildBaseLabelSourceEntries([makePlaceTile(resident(8, 8, 4), placeIn(8, 8, 4))]);
    expect(sameSourceEntries(a, a)).toBe(true);
    expect(sameSourceEntries(a, b)).toBe(false);
  });
});
