// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import { LabelDistanceRules } from "../../labels/base/label-distance-rules.ts";
import type { LabelDistanceRule } from "../../labels/base/label-distance-rules.ts";
import { FlatRingRules, flatRingRule } from "../../tile/visibility/flat-ring-rules.ts";
import type { FlatRingRule } from "../../tile/visibility/flat-ring-rules.ts";
import { RingRuleSets } from "../../tile/visibility/ring-rule-sets.ts";
import type { RingRuleSet } from "../../tile/visibility/ring-rule-sets.ts";
import { clampTo, formatFixed, swiftRounded } from "./debug-overlay-geometry.ts";

/** Rules after an edit of the picker's list, and the rule the picker now has chosen. */
export interface DebugOverlayRuleListEdit<Rules> {
  readonly rules: Rules;
  readonly selectedIndex: number;
}

/** The name of a rule or a set by its zooms: "z14", "z14–17", or "z18+" for the last. */
function zoomSpanTitle(first: number, last: number | undefined): string {
  if (last === undefined) return `z${first}+`;
  return last === first ? `z${first}` : `z${first}\u{2013}${last}`;
}

/** The first zooms the item at `index` of a list sorted by first zoom can take without passing a neighbour. The first item always starts at zoom 0. */
function firstZoomLimits(firstZooms: readonly number[], index: number, upperZoom: number): ClosedRange | undefined {
  if (index <= 0 || index >= firstZooms.length) return undefined;
  const lower = firstZooms[index - 1]! + 1;
  const next = firstZooms[index + 1];
  const upper = next === undefined ? upperZoom : next - 1;
  return lower <= upper ? closedRange(lower, upper) : undefined;
}

/** The first zoom a slider asks for, held between the neighbours, `undefined` for an item whose first zoom cannot move. */
function movedFirstZoom(firstZooms: readonly number[], index: number, upperZoom: number, sliderValue: number): number | undefined {
  const limits = firstZoomLimits(firstZooms, index, upperZoom);
  if (limits === undefined) return undefined;
  return clampTo(swiftRounded(sliderValue), limits.lowerBound, limits.upperBound);
}

/** The first zoom of the upper half of an item that spans `first` to `last`, `undefined` for an item of one zoom. */
function splitZoom(first: number, last: number): number | undefined {
  if (!(last > first)) return undefined;
  return first + Math.floor((last - first + 1) / 2);
}

const labelUpperZoom = LabelDistanceRules.zoomRange[1];

/**
 * The Labels tab's controls (the Swift panel view's label rows): the local
 * detail's reach, how far a distant label may shrink, and the labels' reach
 * by camera zoom (`LabelDistanceRules`), a group of its own whose picker
 * names each rule by its zooms and whose rows edit the chosen rule.
 */
export const DebugOverlayLabelSettingsPlanner = {
  /** How far a distant label may shrink, as a fraction of its size. */
  labelMinimumScaleRange: closedRange(0.3, 1),
  /** The local detail's reach from the camera, in metres. */
  localLabelDistanceRange: closedRange(25, 2000),
  /** A rule's reach, in multiples of the camera's distance to the point it looks at. The top of the range stands for no limit. */
  labelDistanceScaleRange: closedRange(1, 10),
  /** The rule's first zoom slider runs over every zoom. */
  labelDistanceFirstZoomRange: closedRange(LabelDistanceRules.zoomRange[0], LabelDistanceRules.zoomRange[1]),
  baseLabelsGroupTitle: "Base labels",
  labelDistanceGroupTitle: "Label distance",
  roadLabelTilesTitle: "Road label tiles",
  baseLabelBoundsTitle: "Base label boxes",
  roadLabelBoundsTitle: "Road label boxes",
  splitRuleTitle: "Split the label distance rule at a zoom",
  removeRuleTitle: "Remove this label distance rule",

  labelMinimumScaleTitle(scale: number): string {
    return `Label min scale ${formatFixed(scale, 2)}`;
  },

  /** The shrink floor slider, to a hundredth. */
  labelMinimumScale(sliderValue: number): number {
    return swiftRounded(sliderValue * 100) / 100;
  },

  localLabelDistanceTitle(meters: number): string {
    return `Local labels ${swiftRounded(meters)} m`;
  },

  /** The local detail's reach slider, to a whole metre. */
  localLabelDistanceMeters(sliderValue: number): number {
    return swiftRounded(sliderValue);
  },

  /** A rule's name in the picker: its zooms. */
  ruleTitle(rules: readonly LabelDistanceRule[], index: number): string {
    return zoomSpanTitle(rules[index]?.firstZoom ?? 0, LabelDistanceRules.lastZoom(rules, index));
  },

  ruleFirstZoomTitle(firstZoom: number): string {
    return `Rule: starts at zoom ${firstZoom}`;
  },

  /** The first zooms the rule at `index` can take without passing a neighbour. The first rule always starts at zoom 0, `undefined` then, and the slider is disabled. */
  ruleFirstZoomLimits(rules: readonly LabelDistanceRule[], index: number): ClosedRange | undefined {
    return firstZoomLimits(
      rules.map((rule) => rule.firstZoom),
      index,
      labelUpperZoom,
    );
  },

  /** The rule's first zoom slider: the rule moved, held between its neighbours, `undefined` when nothing changes. */
  movingRuleFirstZoom(rules: readonly LabelDistanceRule[], index: number, sliderValue: number): LabelDistanceRule[] | undefined {
    const firstZoom = movedFirstZoom(
      rules.map((rule) => rule.firstZoom),
      index,
      labelUpperZoom,
      sliderValue,
    );
    if (firstZoom === undefined || rules[index]?.firstZoom === firstZoom) return undefined;
    return rules.map((rule, other) => (other === index ? { ...rule, firstZoom } : rule));
  },

  scaleTitle(scale: number): string {
    return Number.isFinite(scale) ? `Distance ${formatFixed(scale, 2)}x` : "Distance off";
  },

  /** Where the reach slider stands for a scale: no limit at the top. */
  scaleSliderValue(scale: number): number {
    const range = DebugOverlayLabelSettingsPlanner.labelDistanceScaleRange;
    return Number.isFinite(scale) ? clampTo(scale, range.lowerBound, range.upperBound) : range.upperBound;
  },

  /** The scale a reach slider stands for, to a twentieth, the top of the range no limit (infinity). */
  scale(sliderValue: number): number {
    const value = swiftRounded(sliderValue * 20) / 20;
    return value >= DebugOverlayLabelSettingsPlanner.labelDistanceScaleRange.upperBound ? Infinity : value;
  },

  /** The reach slider moved: the chosen rule with the new scale, `undefined` when nothing changes. */
  withRuleScale(rules: readonly LabelDistanceRule[], index: number, sliderValue: number): LabelDistanceRule[] | undefined {
    const scale = DebugOverlayLabelSettingsPlanner.scale(sliderValue);
    const rule = rules[index];
    if (rule === undefined || rule.scale === scale) return undefined;
    return rules.map((other, position) => (position === index ? { ...other, scale } : other));
  },

  /** Splits the chosen rule: a new rule with the same reach takes the upper half of its zooms and becomes the chosen one. `undefined` for a rule of one zoom. */
  splittingRule(rules: readonly LabelDistanceRule[], index: number): DebugOverlayRuleListEdit<LabelDistanceRule[]> | undefined {
    const rule = rules[index];
    if (rule === undefined) return undefined;
    const split = splitZoom(rule.firstZoom, LabelDistanceRules.lastZoom(rules, index) ?? labelUpperZoom);
    if (split === undefined) return undefined;
    const next = [...rules];
    next.splice(index + 1, 0, { ...rule, firstZoom: split });
    return { rules: next, selectedIndex: index + 1 };
  },

  /** Removes the chosen rule: its zooms go to the rule before it, or, for the first rule, to the one after. `undefined` for the last rule left. */
  removingRule(rules: readonly LabelDistanceRule[], index: number): DebugOverlayRuleListEdit<LabelDistanceRule[]> | undefined {
    if (rules.length <= 1 || index < 0 || index >= rules.length) return undefined;
    const next = rules.filter((_, other) => other !== index);
    next[0] = { ...next[0]!, firstZoom: LabelDistanceRules.zoomRange[0] };
    return { rules: next, selectedIndex: Math.max(index - 1, 0) };
  },

  /** Whether the remove button can be used: a list keeps one rule. */
  canRemoveRule(rules: readonly LabelDistanceRule[]): boolean {
    return rules.length > 1;
  },
} as const;

/** One switch or picker of a ring rule's card. */
export type DebugOverlayRingRuleField =
  | { readonly kind: "zoomDropSegment"; readonly segment: number }
  | { readonly kind: "distanceSlider"; readonly sliderValue: number }
  | { readonly kind: "drawsLines"; readonly isOn: boolean }
  | { readonly kind: "drawsLabels"; readonly isOn: boolean }
  | { readonly kind: "rasterSegment"; readonly segment: number }
  | { readonly kind: "terrainSegment"; readonly segment: number };

const ringUpperZoom = RingRuleSets.zoomRange.upperBound;

function setsWithRules(sets: readonly RingRuleSet[], setIndex: number, rules: readonly FlatRingRule[]): RingRuleSets {
  return { sets: sets.map((set, index) => (index === setIndex ? { firstZoom: set.firstZoom, rules: { rules } } : set)) };
}

function rangeValues(range: { readonly lowerBound: number; readonly upperBound: number }): number[] {
  const values: number[] = [];
  for (let value = range.lowerBound; value <= range.upperBound; value += 1) values.push(value);
  return values;
}

/**
 * The Map tab's ring rules (the Swift panel view's rule cards and set
 * picker): the rule sets by target zoom (`RingRuleSets`), a picker naming
 * each set by its zooms and choosing the one the rule cards edit, a slider
 * moving the chosen set's first zoom between its neighbours, and a card per
 * rule of the chosen set with its drop picker, distance slider, line and
 * label switches, raster picker and terrain picker. Every edit sends the
 * sets whole. `selectedSetIndex` is the picker's.
 */
export const DebugOverlayRingRuleEditing = {
  groupTitle: "Ring rules",
  dropTitle: "Zoom drop",
  linesTitle: "Draw lines",
  labelsTitle: "Draw labels",
  rasterTitle: "Ground from a texture",
  splitSetTitle: "Split the rule set at a zoom",
  removeSetTitle: "Remove this rule set",
  addRuleTitle: "Add ring rule",
  removeRuleTitle: "Remove last ring rule",
  /** The drop picker's segments, one per zoom drop. */
  dropChoiceTitles: Object.freeze(rangeValues(FlatRingRules.zoomDropRange).map(String)) as readonly string[],
  /** The terrain picker's segments, one per terrain zoom drop. */
  terrainChoiceTitles: Object.freeze(rangeValues(FlatRingRules.terrainZoomDropRange).map(String)) as readonly string[],
  /** The raster picker's choices: geometry, then every texture edge (`FlatRingRules.rasterSizes`). */
  rasterChoiceTitles: Object.freeze(["Off", ...FlatRingRules.rasterSizes.map(String)]) as readonly string[],
  /** The distance slider runs on the square root of the ring number, so the first rings, where one step matters, take most of its travel. */
  distanceSliderRange: closedRange(0, Math.sqrt(FlatRingRules.distanceRange.upperBound)),
  /** The set's first zoom slider runs over every zoom. */
  setFirstZoomRange: closedRange(RingRuleSets.zoomRange.lowerBound, RingRuleSets.zoomRange.upperBound),

  /** The card's name: the rule's number, the rows under it name no rule. */
  cardTitle(index: number): string {
    return `Rule ${index + 1}`;
  },

  distanceTitle(distance: number): string {
    return `To ring ${distance} from the look-at tile`;
  },

  distanceSliderValue(distance: number): number {
    return Math.sqrt(Math.max(distance, 0));
  },

  distance(sliderValue: number): number {
    const distance = swiftRounded(sliderValue * sliderValue);
    return clampTo(distance, FlatRingRules.distanceRange.lowerBound, FlatRingRules.distanceRange.upperBound);
  },

  dropSegment(zoomDrop: number): number {
    return zoomDrop - FlatRingRules.zoomDropRange.lowerBound;
  },

  terrainSegment(terrainZoomDrop: number): number {
    return terrainZoomDrop - FlatRingRules.terrainZoomDropRange.lowerBound;
  },

  rasterChoiceIndex(rasterSize: number | undefined): number {
    if (rasterSize === undefined) return 0;
    const index = FlatRingRules.rasterSizes.indexOf(rasterSize);
    return index < 0 ? 0 : index + 1;
  },

  rasterSize(choiceIndex: number): number | undefined {
    return FlatRingRules.rasterSizes[choiceIndex - 1];
  },

  /** The terrain's title names the zooms under the band's tiles: 0 is the tiles' own terrain, the finest the source has. */
  terrainTitle(drop: number): string {
    return drop === 0 ? "Terrain of the tiles' own zoom" : `Terrain ${drop} zooms coarser`;
  },

  /** A set's name in the picker: its zooms. */
  setTitle(sets: RingRuleSets, index: number): string {
    return zoomSpanTitle(sets.sets[index]?.firstZoom ?? 0, RingRuleSets.lastZoom(sets, index));
  },

  setFirstZoomTitle(firstZoom: number): string {
    return `Rule set: starts at zoom ${firstZoom}`;
  },

  /** The first zooms the set at `index` can take without passing a neighbour. The first set always starts at zoom 0, `undefined` then, and the slider is disabled. */
  setFirstZoomLimits(sets: RingRuleSets, index: number): ClosedRange | undefined {
    return firstZoomLimits(
      sets.sets.map((set) => set.firstZoom),
      index,
      ringUpperZoom,
    );
  },

  /** The set's first zoom slider: the set moved, held between its neighbours, `undefined` when nothing changes. */
  movingSetFirstZoom(sets: RingRuleSets, index: number, sliderValue: number): RingRuleSets | undefined {
    const firstZoom = movedFirstZoom(
      sets.sets.map((set) => set.firstZoom),
      index,
      ringUpperZoom,
      sliderValue,
    );
    if (firstZoom === undefined || sets.sets[index]?.firstZoom === firstZoom) return undefined;
    return { sets: sets.sets.map((set, other) => (other === index ? { firstZoom, rules: set.rules } : set)) };
  },

  /** The rules the cards edit: the chosen set's. */
  rules(sets: RingRuleSets, selectedSetIndex: number): readonly FlatRingRule[] {
    const index = Math.min(selectedSetIndex, sets.sets.length - 1);
    return sets.sets[index]?.rules.rules ?? [];
  },

  /** Splits the chosen set: a new set with the same rules takes the upper half of its zooms and becomes the chosen one. `undefined` for a set of one zoom. */
  splittingSet(sets: RingRuleSets, index: number): DebugOverlayRuleListEdit<RingRuleSets> | undefined {
    const set = sets.sets[index];
    if (set === undefined) return undefined;
    const split = splitZoom(set.firstZoom, RingRuleSets.lastZoom(sets, index) ?? ringUpperZoom);
    if (split === undefined) return undefined;
    const next = [...sets.sets];
    next.splice(index + 1, 0, { firstZoom: split, rules: set.rules });
    return { rules: { sets: next }, selectedIndex: index + 1 };
  },

  /** Removes the chosen set: its zooms go to the set before it, or, for the first set, to the one after. `undefined` for the last set left. */
  removingSet(sets: RingRuleSets, index: number): DebugOverlayRuleListEdit<RingRuleSets> | undefined {
    if (sets.sets.length <= 1 || index < 0 || index >= sets.sets.length) return undefined;
    const next = sets.sets.filter((_, other) => other !== index);
    next[0] = { firstZoom: RingRuleSets.zoomRange.lowerBound, rules: next[0]!.rules };
    return { rules: { sets: next }, selectedIndex: Math.max(index - 1, 0) };
  },

  canRemoveSet(sets: RingRuleSets): boolean {
    return sets.sets.length > 1;
  },

  /**
   * A new last rule in the chosen set: two levels coarser than the last and
   * reaching twice as many rings (at least one more), its terrain a zoom
   * coarser again, inside the ranges. `undefined` when the last rule already
   * reaches the farthest ring.
   */
  addingRule(sets: RingRuleSets, selectedSetIndex: number): RingRuleSets | undefined {
    const index = Math.min(selectedSetIndex, sets.sets.length - 1);
    const rules = DebugOverlayRingRuleEditing.rules(sets, index);
    const last = rules.at(-1) ?? FlatRingRules.default.rules[0]!;
    const rule = flatRingRule(
      Math.min(last.zoomDrop + 2, FlatRingRules.zoomDropRange.upperBound),
      Math.min(Math.max(last.distance * 2, last.distance + 1), FlatRingRules.distanceRange.upperBound),
      { terrainZoomDrop: Math.min(last.terrainZoomDrop + 1, FlatRingRules.terrainZoomDropRange.upperBound) },
    );
    if (!(rule.distance > last.distance)) return undefined;
    return setsWithRules(sets.sets, index, [...rules, rule]);
  },

  /** The chosen set without its last rule, `undefined` for a set of one rule. */
  removingLastRule(sets: RingRuleSets, selectedSetIndex: number): RingRuleSets | undefined {
    const index = Math.min(selectedSetIndex, sets.sets.length - 1);
    const rules = DebugOverlayRingRuleEditing.rules(sets, index);
    if (rules.length <= 1) return undefined;
    return setsWithRules(sets.sets, index, rules.slice(0, -1));
  },

  canRemoveRule(sets: RingRuleSets, selectedSetIndex: number): boolean {
    return DebugOverlayRingRuleEditing.rules(sets, selectedSetIndex).length > 1;
  },

  /** One control of the rule at `ruleIndex` of the chosen set changed: the sets with it, `undefined` when nothing changes. */
  editingRule(sets: RingRuleSets, selectedSetIndex: number, ruleIndex: number, field: DebugOverlayRingRuleField): RingRuleSets | undefined {
    const index = Math.min(selectedSetIndex, sets.sets.length - 1);
    const rules = DebugOverlayRingRuleEditing.rules(sets, index);
    const rule = rules[ruleIndex];
    if (rule === undefined) return undefined;
    let edited: FlatRingRule;
    switch (field.kind) {
      case "zoomDropSegment":
        edited = { ...rule, zoomDrop: field.segment + FlatRingRules.zoomDropRange.lowerBound };
        break;
      case "distanceSlider": {
        const distance = DebugOverlayRingRuleEditing.distance(field.sliderValue);
        if (distance === rule.distance) return undefined;
        edited = { ...rule, distance };
        break;
      }
      case "drawsLines":
        edited = { ...rule, drawsLines: field.isOn };
        break;
      case "drawsLabels":
        edited = { ...rule, drawsLabels: field.isOn };
        break;
      case "rasterSegment":
        edited = { ...rule, rasterSize: DebugOverlayRingRuleEditing.rasterSize(field.segment) };
        break;
      case "terrainSegment":
        edited = { ...rule, terrainZoomDrop: field.segment + FlatRingRules.terrainZoomDropRange.lowerBound };
        break;
    }
    return setsWithRules(
      sets.sets,
      index,
      rules.map((other, position) => (position === ruleIndex ? edited : other)),
    );
  },
} as const;
