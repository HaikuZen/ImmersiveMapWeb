// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { modelTileKeyOver, ReplacedBuildings } from "./scene-model-frame-state.ts";

/** Swift `ReplacedBuildingsTests`: a map tile leaves out the ids listed for its own zoom. */
describe("ReplacedBuildings", () => {
  it("gives a map tile the list of its own zoom", () => {
    const replaced = new ReplacedBuildings({ 14: [100], 15: [1, 2] });
    expect([...replaced.ids(14)]).toEqual([100]);
    expect([...replaced.ids(15)]).toEqual([1, 2]);
  });

  it("gives a tile deeper than every list the deepest", () => {
    const replaced = new ReplacedBuildings({ 14: [100], 15: [1, 2] });
    expect([...replaced.ids(16)]).toEqual([1, 2]);
  });

  it("gives a shallower tile with no list of its own none", () => {
    expect(new ReplacedBuildings({ 15: [1, 2] }).ids(14).size).toBe(0);
    expect(ReplacedBuildings.none.ids(15).size).toBe(0);
  });

  it("adds the lists of several model tiles up zoom by zoom", () => {
    let replaced = ReplacedBuildings.none;
    expect(replaced.isEmpty).toBe(true);
    replaced = replaced.union(new Map([[14, new Set([100])], [15, new Set([1])]]));
    replaced = replaced.union(new Map([[15, new Set([2])]]));
    expect(replaced.equals(new ReplacedBuildings({ 14: [100], 15: [1, 2] }))).toBe(true);
    expect(replaced.isEmpty).toBe(false);
    expect(new ReplacedBuildings({ 15: [] }).isEmpty).toBe(true);
    // The union leaves the lists it started from as they were.
    expect(ReplacedBuildings.none.isEmpty).toBe(true);
  });

  it("names the model tile over a map tile", () => {
    expect(modelTileKeyOver({ x: 9904 * 4 + 3, y: 5121 * 4, z: 16 }, 14)).toBe("14/9904/5121");
    expect(modelTileKeyOver({ x: 4952, y: 2560, z: 13 }, 14)).toBe("13/4952/2560");
  });
});
