// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The Map tab's ring rules and the Labels tab's label distance rules, the
// edits the Swift panel view makes in its button and slider actions.

import { describe, expect, test } from "vitest";
import { LabelDistanceRules } from "../../labels/base/label-distance-rules.ts";
import { FlatRingRules, flatRingRule } from "../../tile/visibility/flat-ring-rules.ts";
import { RingRuleSets } from "../../tile/visibility/ring-rule-sets.ts";
import { DebugOverlayLabelSettingsPlanner as Labels, DebugOverlayRingRuleEditing as Rings } from "./debug-overlay-rule-editing.ts";

describe("the label distance rules", () => {
  const rules = LabelDistanceRules.default;

  test("a rule is named by its zooms", () => {
    expect([0, 1, 2].map((index) => Labels.ruleTitle(rules, index))).toEqual(["z0\u{2013}13", "z14\u{2013}17", "z18+"]);
    expect(Labels.ruleTitle([{ firstZoom: 0, scale: 1 }, { firstZoom: 1, scale: 1 }], 0)).toBe("z0");
  });

  test("a rule's first zoom moves between its neighbours, the first rule's not at all", () => {
    expect(Labels.ruleFirstZoomLimits(rules, 0)).toBeUndefined();
    expect(Labels.ruleFirstZoomLimits(rules, 1)).toEqual({ lowerBound: 1, upperBound: 17 });
    expect(Labels.ruleFirstZoomLimits(rules, 2)).toEqual({ lowerBound: 15, upperBound: 22 });
    expect(Labels.movingRuleFirstZoom(rules, 1, 30)?.[1]?.firstZoom).toBe(17);
    expect(Labels.movingRuleFirstZoom(rules, 1, 14.2)).toBeUndefined();
    expect(Labels.movingRuleFirstZoom(rules, 0, 3)).toBeUndefined();
  });

  /** The top of the reach slider is no limit. */
  test("the reach slider goes out in twentieths, its top no limit", () => {
    expect(Labels.scale(1.26)).toBe(1.25);
    expect(Labels.scale(10)).toBe(Infinity);
    expect(Labels.scaleTitle(Infinity)).toBe("Distance off");
    expect(Labels.scaleTitle(1.25)).toBe("Distance 1.25x");
    expect(Labels.scaleSliderValue(Infinity)).toBe(10);
    expect(Labels.withRuleScale(rules, 1, 1.25)).toBeUndefined();
    expect(Labels.withRuleScale(rules, 1, 3)?.[1]?.scale).toBe(3);
  });

  test("a split gives the upper half of the rule's zooms to a copy, a removal its zooms to the rule before", () => {
    const split = Labels.splittingRule(rules, 1);
    expect(split?.rules.map((rule) => rule.firstZoom)).toEqual([0, 14, 16, 18]);
    expect(split?.rules[2]?.scale).toBe(rules[1]!.scale);
    expect(split?.selectedIndex).toBe(2);
    expect(Labels.splittingRule([{ firstZoom: 0, scale: 1 }, { firstZoom: 1, scale: 1 }], 0)).toBeUndefined();

    const removedFirst = Labels.removingRule(rules, 0);
    expect(removedFirst?.rules).toEqual([{ firstZoom: 0, scale: rules[1]!.scale }, rules[2]]);
    expect(removedFirst?.selectedIndex).toBe(0);
    expect(Labels.removingRule([{ firstZoom: 0, scale: 1 }], 0)).toBeUndefined();
  });

  test("the label rows' sliders and titles", () => {
    expect(Labels.labelMinimumScale(0.456)).toBe(0.46);
    expect(Labels.labelMinimumScaleTitle(0.46)).toBe("Label min scale 0.46");
    expect(Labels.localLabelDistanceMeters(250.4)).toBe(250);
    expect(Labels.localLabelDistanceTitle(250)).toBe("Local labels 250 m");
  });
});

describe("the ring rules", () => {
  const sets = RingRuleSets.default;

  test("a set is named by its zooms and moves between its neighbours", () => {
    expect(sets.sets.map((_, index) => Rings.setTitle(sets, index))).toEqual(["z0\u{2013}6", "z7\u{2013}14", "z15\u{2013}16", "z17+"]);
    expect(Rings.setFirstZoomLimits(sets, 0)).toBeUndefined();
    expect(Rings.setFirstZoomLimits(sets, 2)).toEqual({ lowerBound: 8, upperBound: 16 });
    expect(Rings.movingSetFirstZoom(sets, 2, 3)?.sets[2]?.firstZoom).toBe(8);
    expect(Rings.setFirstZoomTitle(15)).toBe("Rule set: starts at zoom 15");
  });

  test("a set's split copies its rules into its upper zooms, a removal gives them to the set before", () => {
    const split = Rings.splittingSet(sets, 1);
    expect(split?.rules.sets.map((set) => set.firstZoom)).toEqual([0, 7, 11, 15, 17]);
    expect(split?.rules.sets[2]?.rules).toBe(sets.sets[1]!.rules);
    expect(split?.selectedIndex).toBe(2);
    const removed = Rings.removingSet(sets, 0);
    expect(removed?.rules.sets[0]?.firstZoom).toBe(0);
    expect(removed?.rules.sets[0]?.rules).toBe(sets.sets[1]!.rules);
    expect(Rings.removingSet({ sets: [sets.sets[0]!] }, 0)).toBeUndefined();
  });

  /** A new last rule steps two levels coarser and twice as far, its terrain a zoom coarser, inside the ranges. */
  test("an added rule steps out from the last", () => {
    const added = Rings.addingRule(sets, 1);
    const rules = Rings.rules(added!, 1);
    expect(rules).toHaveLength(FlatRingRules.default.rules.length + 1);
    expect(rules.at(-1)).toEqual(flatRingRule(6, 18, { terrainZoomDrop: 4 }));
    expect(Rings.rules(added!, 0)).toBe(sets.sets[0]!.rules.rules);
    const farthest = { sets: [{ firstZoom: 0, rules: { rules: [flatRingRule(8, 256)] } }] };
    expect(Rings.addingRule(farthest, 0)).toBeUndefined();
    expect(Rings.removingLastRule(farthest, 0)).toBeUndefined();
    expect(Rings.rules(Rings.removingLastRule(sets, 1)!, 1)).toHaveLength(FlatRingRules.default.rules.length - 1);
  });

  test("a card's controls edit their rule", () => {
    const raster = Rings.editingRule(sets, 1, 0, { kind: "rasterSegment", segment: 2 });
    expect(Rings.rules(raster!, 1)[0]?.rasterSize).toBe(128);
    const off = Rings.editingRule(sets, 1, 1, { kind: "rasterSegment", segment: 0 });
    expect(Rings.rules(off!, 1)[1]?.rasterSize).toBeUndefined();
    const lines = Rings.editingRule(sets, 1, 0, { kind: "drawsLines", isOn: false });
    expect(Rings.rules(lines!, 1)[0]?.drawsLines).toBe(false);
    const distance = Rings.editingRule(sets, 1, 0, { kind: "distanceSlider", sliderValue: 2 });
    expect(Rings.rules(distance!, 1)[0]?.distance).toBe(4);
    expect(Rings.editingRule(sets, 1, 0, { kind: "distanceSlider", sliderValue: 1.1 })).toBeUndefined();
    const terrain = Rings.editingRule(sets, 1, 0, { kind: "terrainSegment", segment: 3 });
    expect(Rings.rules(terrain!, 1)[0]?.terrainZoomDrop).toBe(3);
  });

  test("the card's titles and pickers", () => {
    expect(Rings.cardTitle(0)).toBe("Rule 1");
    expect(Rings.distanceTitle(3)).toBe("To ring 3 from the look-at tile");
    expect(Rings.distance(Rings.distanceSliderValue(9))).toBe(9);
    expect(Rings.distance(100)).toBe(256);
    expect(Rings.rasterChoiceTitles).toEqual(["Off", "64", "128", "256", "512", "1024"]);
    expect(Rings.rasterChoiceIndex(256)).toBe(3);
    expect(Rings.rasterChoiceIndex(undefined)).toBe(0);
    expect(Rings.rasterSize(0)).toBeUndefined();
    expect(Rings.terrainTitle(0)).toBe("Terrain of the tiles' own zoom");
    expect(Rings.terrainTitle(3)).toBe("Terrain 3 zooms coarser");
    expect(Rings.dropChoiceTitles).toHaveLength(9);
  });
});
