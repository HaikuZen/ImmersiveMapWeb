// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `LabelDistanceRulesTests`: the labels' reach by
// camera zoom.

import { describe, expect, test } from "vitest";
import { LabelDistanceRules } from "./label-distance-rules.ts";

describe("LabelDistanceRules", () => {
  // A frame reads the rule its camera zoom's whole part falls in.
  test("the reach is the rule of the camera zoom", () => {
    const rules = LabelDistanceRules.normalized([
      { firstZoom: 0, scale: Infinity },
      { firstZoom: 15, scale: 2 },
      { firstZoom: 17, scale: 1.25 },
    ]);
    expect(LabelDistanceRules.scale(rules, 3)).toBe(Infinity);
    expect(LabelDistanceRules.scale(rules, 16.9)).toBe(2);
    expect(LabelDistanceRules.scale(rules, 17)).toBe(1.25);
    expect(LabelDistanceRules.scale(rules, 40)).toBe(1.25);
    expect(LabelDistanceRules.lastZoom(rules, 1)).toBe(16);
    expect(LabelDistanceRules.lastZoom(rules, 2)).toBeUndefined();
  });

  // The rules as a frame reads them: sorted, one per first zoom, the first
  // one from zoom 0, no negative or undefined reach.
  test("normalization cleans the rules", () => {
    const rules = LabelDistanceRules.normalized([
      { firstZoom: 12, scale: Number.NaN },
      { firstZoom: 5, scale: -1 },
      { firstZoom: 12, scale: 3 },
    ]);
    expect(rules).toEqual([
      { firstZoom: 0, scale: 0 },
      { firstZoom: 12, scale: LabelDistanceRules.defaultScale },
    ]);
    expect(LabelDistanceRules.normalized([])).toEqual(LabelDistanceRules.default);
  });

  test("a camera zoom that is no number reads the first rule", () => {
    expect(LabelDistanceRules.ruleZoom(Number.NaN)).toBe(0);
    expect(LabelDistanceRules.ruleZoom(-4)).toBe(0);
    expect(LabelDistanceRules.ruleZoom(30)).toBe(22);
    expect(LabelDistanceRules.scale(LabelDistanceRules.default, Number.NaN)).toBe(5);
  });
});
