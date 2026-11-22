// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BuildingRiseCoverageTests`: a label on a roof rises
// with the buildings drawn under it, by the tile and the quarter that draw
// them, whichever tile the label comes from.

import { describe, expect, test } from "vitest";
import { quartersAll } from "../tile-quarters.ts";
import type { Tile } from "../tile.ts";
import { BuildingRiseCoverage } from "./building-rise-coverage.ts";

const cell: Tile = { x: 9908, y: 5140, z: 14 };
/** The cell's north-west and north-east children. */
const northWest: Tile = { x: 19816, y: 10280, z: 15 };
const northEast: Tile = { x: 19817, y: 10280, z: 15 };

/** The cell draws its southern quarters, its two northern children draw theirs. */
function coverage(): BuildingRiseCoverage {
  const result = new BuildingRiseCoverage();
  result.add(cell, 0b1100, 0.5);
  result.add(northWest, quartersAll, 1);
  result.add(northEast, quartersAll, 0.75);
  return result;
}

describe("BuildingRiseCoverage", () => {
  test("a label of the cell rises with the tile that draws its quarter", () => {
    expect(coverage().rise(cell, 0.25, 0.75), "a quarter the cell draws").toBe(0.5);
    expect(coverage().rise(cell, 0.25, 0.25), "the north-west child's").toBe(1);
    expect(coverage().rise(cell, 0.75, 0.25), "the north-east child's").toBe(0.75);
  });

  test("a label of a child rises with the quarter of the cell over it", () => {
    const southWest: Tile = { x: 19816, y: 10281, z: 15 };
    expect(coverage().rise(southWest, 0.5, 0.5)).toBe(0.5);
    expect(coverage().rise(northWest, 0.5, 0.5), "its own").toBe(1);
  });

  test("a label where no buildings draw stays on the ground", () => {
    const only = new BuildingRiseCoverage();
    only.add(cell, 0b0001, 1);
    expect(only.rise(cell, 0.75, 0.75)).toBe(0);
    expect(only.rise({ x: 19817, y: 10281, z: 15 }, 0.5, 0.5)).toBe(0);
    expect(only.rise({ x: 0, y: 0, z: 15 }, 0.5, 0.5), "elsewhere").toBe(0);
    expect(BuildingRiseCoverage.none.rise(cell, 0.5, 0.5)).toBe(0);
  });

  test("two copies of a tile join", () => {
    const joined = new BuildingRiseCoverage();
    joined.add(cell, 0b0001, 0.25);
    joined.add(cell, 0b1000, 0.5);
    expect(joined.rise(cell, 0.25, 0.25)).toBe(0.5);
    expect(joined.rise(cell, 0.75, 0.75)).toBe(0.5);
    expect(joined.rise(cell, 0.75, 0.25)).toBe(0);
  });

  test("a cleared coverage is empty", () => {
    const cleared = coverage();
    cleared.clear();
    expect(cleared.isEmpty).toBe(true);
    expect(cleared.rise(cell, 0.25, 0.75)).toBe(0);
  });
});
