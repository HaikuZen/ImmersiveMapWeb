// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A port of the trees' case of the Swift `TileQuartersTests`.

import { describe, expect, test } from "vitest";
import { quartersAll } from "../tile-quarters.ts";
import { treeInstanceRanges } from "./tree-instance-ranges.ts";

describe("treeInstanceRanges", () => {
  test("the trees of the quarters drawn, thinned by the zoom's share", () => {
    const starts = [0, 10, 10, 30, 31];
    expect(treeInstanceRanges(31, starts, quartersAll, 1)).toEqual([
      [0, 10],
      [10, 30],
      [30, 31],
    ]);
    expect(treeInstanceRanges(31, starts, 0b1100, 0.5)).toEqual([
      [10, 20],
      [30, 31],
    ]);
    expect(treeInstanceRanges(31, [], quartersAll, 0.5)).toEqual([[0, 16]]);
    expect(treeInstanceRanges(31, [], 0b0001, 1)).toEqual([]);
  });

  test("a run that has trees keeps at least one", () => {
    expect(treeInstanceRanges(100, [], quartersAll, 0.001)).toEqual([[0, 1]]);
    expect(treeInstanceRanges(0, [], quartersAll, 1)).toEqual([]);
  });
});
