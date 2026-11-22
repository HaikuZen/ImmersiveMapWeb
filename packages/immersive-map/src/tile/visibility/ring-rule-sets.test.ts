// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `RingRuleSetsTests`: which set a frame reads, and the
// shape the sets are kept in.

import { describe, expect, test } from "vitest";
import { flatRingRule, FlatRingRules } from "./flat-ring-rules.ts";
import { FrameVisibilityResolver } from "./frame-visibility-resolver.ts";
import { RingRuleSets } from "./ring-rule-sets.ts";

const near: FlatRingRules = { rules: [flatRingRule(0, 2)] };
const far: FlatRingRules = { rules: [flatRingRule(1, 5)] };

describe("RingRuleSets", () => {
  test("a frame reads the set its zoom falls in", () => {
    const sets: RingRuleSets = { sets: [{ firstZoom: 0, rules: near }, { firstZoom: 8, rules: far }] };
    expect(RingRuleSets.rulesForZoom(sets, 0)).toEqual(FlatRingRules.normalized(near));
    expect(RingRuleSets.rulesForZoom(sets, 7)).toEqual(FlatRingRules.normalized(near));
    expect(RingRuleSets.rulesForZoom(sets, 8)).toEqual(FlatRingRules.normalized(far));
    expect(RingRuleSets.rulesForZoom(sets, 16)).toEqual(FlatRingRules.normalized(far));
    expect(RingRuleSets.lastZoom(sets, 0)).toBe(7);
    expect(RingRuleSets.lastZoom(sets, 1)).toBeUndefined();
  });

  test("the sets are kept in order", () => {
    const wild = RingRuleSets.normalized({
      sets: [
        { firstZoom: 9, rules: far },
        { firstZoom: 3, rules: near },
        { firstZoom: 9, rules: near },
        { firstZoom: 99, rules: far },
      ],
    });
    expect(wild.sets.map((set) => set.firstZoom)).toEqual([0, 9, RingRuleSets.zoomRange.upperBound]);
    expect(wild.sets[0]!.rules, "the lowest set takes the zooms under it").toEqual(FlatRingRules.normalized(near));
    expect(RingRuleSets.normalized({ sets: [] })).toEqual(RingRuleSets.default);
    expect(RingRuleSets.normalized(RingRuleSets.default), "the default is already normal").toEqual(RingRuleSets.default);
  });

  test("the default splits at the end of the unroll and among the buildings", () => {
    const sets = RingRuleSets.default;
    expect(sets.sets.map((set) => set.firstZoom)).toEqual([0, 7, 15, 17]);
    expect(RingRuleSets.rulesForZoom(sets, 6)).toEqual(FlatRingRules.globeDefault);
    expect(RingRuleSets.rulesForZoom(sets, 7)).toEqual(FlatRingRules.default);
    expect(RingRuleSets.rulesForZoom(sets, 14)).toEqual(FlatRingRules.default);
    expect(RingRuleSets.rulesForZoom(sets, 16)).toEqual(FlatRingRules.nearStreetDefault);
    expect(RingRuleSets.rulesForZoom(sets, 17)).toEqual(FlatRingRules.closeStreetDefault);
    expect(RingRuleSets.rulesForZoom(sets, 22)).toEqual(FlatRingRules.closeStreetDefault);

    const nearStreet = FlatRingRules.nearStreetDefault.rules;
    expect(nearStreet.map((rule) => rule.zoomDrop)).toEqual([0, 1, 4]);
    expect(nearStreet.map((rule) => rule.distance)).toEqual([1, 3, 13]);
    expect(nearStreet.map((rule) => rule.drawsLines)).toEqual([true, true, false]);
    expect(nearStreet.map((rule) => rule.drawsLabels)).toEqual([true, false, false]);
    expect(nearStreet.map((rule) => rule.rasterSize)).toEqual([undefined, 64, 128]);
    const close = FlatRingRules.closeStreetDefault.rules;
    expect(close.map((rule) => rule.zoomDrop)).toEqual([0, 2]);
    expect(close.map((rule) => rule.distance)).toEqual([1, 2]);
    expect(close.map((rule) => rule.drawsLines)).toEqual([true, false]);
    expect(close.map((rule) => rule.drawsLabels)).toEqual([true, false]);
    expect(close.map((rule) => rule.rasterSize)).toEqual([undefined, 128]);
    expect(FlatRingRules.normalized(FlatRingRules.nearStreetDefault)).toEqual(FlatRingRules.nearStreetDefault);
    expect(FlatRingRules.normalized(FlatRingRules.closeStreetDefault)).toEqual(FlatRingRules.closeStreetDefault);
    const globe = FlatRingRules.globeDefault.rules;
    expect(globe.map((rule) => rule.zoomDrop)).toEqual([0, 2]);
    expect(globe.map((rule) => rule.distance)).toEqual([1, 3]);
    expect(globe.map((rule) => rule.drawsLines)).toEqual([true, false]);
    expect(globe.map((rule) => rule.drawsLabels)).toEqual([true, true]);
    expect(globe.map((rule) => rule.rasterSize)).toEqual([undefined, undefined]);
  });

  test("a set past the deepest tile zoom is chosen by the camera zoom", () => {
    const deep: FlatRingRules = { rules: [flatRingRule(0, 0, { drawsLines: false, drawsLabels: false })] };
    const sets: RingRuleSets = {
      sets: [
        { firstZoom: 0, rules: FlatRingRules.globeDefault },
        { firstZoom: 7, rules: FlatRingRules.default },
        { firstZoom: 16, rules: deep },
      ],
    };
    expect(FrameVisibilityResolver.ruleSetZoom(16.4)).toBe(16);
    expect(RingRuleSets.rulesForZoom(sets, FrameVisibilityResolver.ruleSetZoom(16.4))).toEqual(deep);
    expect(RingRuleSets.rulesForZoom(sets, FrameVisibilityResolver.ruleSetZoom(15.9))).toEqual(FlatRingRules.default);
    expect(FrameVisibilityResolver.ruleSetZoom(-1)).toBe(0);
    expect(FrameVisibilityResolver.ruleSetZoom(40)).toBe(RingRuleSets.zoomRange.upperBound);
  });
});
