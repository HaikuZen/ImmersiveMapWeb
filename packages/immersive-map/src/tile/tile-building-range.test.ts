// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { buildingIndexRuns, tileBuildingRanges } from "./tile-building-range.ts";

/** Swift `TileBuildingRangeTests`: what a tile draws of its buildings when the frame leaves some out. */
describe("TileBuildingRange", () => {
  const ranges = (...r: [number, number, number][]) => tileBuildingRanges(r);

  it("draws the tile whole with nothing of it hidden", () => {
    const r = ranges([1, 0, 30], [2, 30, 60]);
    expect(buildingIndexRuns(r, 90, new Set())).toBeUndefined();
    // A building of another tile changes nothing here.
    expect(buildingIndexRuns(r, 90, new Set([7]))).toBeUndefined();
    expect(buildingIndexRuns(ranges(), 90, new Set([1]))).toBeUndefined();
  });

  it("cuts a hidden building out of the draw", () => {
    const r = ranges([1, 0, 30], [2, 30, 60], [3, 90, 30]);
    expect(buildingIndexRuns(r, 120, new Set([2]))).toEqual([[0, 30], [90, 120]]);
    expect(buildingIndexRuns(r, 120, new Set([1]))).toEqual([[30, 120]]);
    expect(buildingIndexRuns(r, 120, new Set([3]))).toEqual([[0, 90]]);
    expect(buildingIndexRuns(r, 120, new Set([1, 2, 3]))).toEqual([]);
  });

  it("takes every volume of a building of several out", () => {
    const r = ranges([5, 0, 30], [5, 60, 30], [9, 30, 30]);
    expect(buildingIndexRuns(r, 90, new Set([5]))).toEqual([[30, 60]]);
  });

  it("cuts only the listed ids", () => {
    // An outline 5 and its parts 11 and 12, as three buildings.
    const r = ranges([5, 0, 30], [11, 30, 30], [12, 60, 30]);
    expect(buildingIndexRuns(r, 90, new Set([5]))).toEqual([[30, 90]]);
    expect(buildingIndexRuns(r, 90, new Set([5, 11, 12]))).toEqual([]);
  });

  it("keeps the indices outside every range", () => {
    expect(buildingIndexRuns(ranges([4, 30, 30]), 100, new Set([4]))).toEqual([[0, 30], [60, 100]]);
  });

  it("reads the arena's decimal ids as numbers, above 2^32", () => {
    const id = 3 * 2 ** 44 + 3334755;
    const r = tileBuildingRanges([[String(id), 6, 3]]);
    expect(buildingIndexRuns(r, 12, new Set([id]))).toEqual([[0, 6], [9, 12]]);
  });
});
