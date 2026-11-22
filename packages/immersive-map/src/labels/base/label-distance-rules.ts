// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * How far from the camera the labels show over one stretch of camera zooms:
 * from `firstZoom` up to the zoom before the next rule's first (the Swift
 * `LabelDistanceRule`). `scale` is in multiples of the camera's distance to
 * the point it looks at, point labels and road names alike: a label farther
 * than that fades out and comes back as the camera nears it. Measured along
 * the view, so a camera looking straight down keeps every label and a
 * tilted one lets the labels up toward the horizon go. Infinity keeps every
 * label.
 */
export interface LabelDistanceRule {
  readonly firstZoom: number;
  readonly scale: number;
}

const defaultScale = 1.25;
const zoomRange = [0, 22] as const;

/**
 * The labels' reach by camera zoom (the Swift `LabelDistanceRules`): any
 * number of rules, each owning the zooms from its first to the next rule's,
 * the last one to the deepest zoom. A frame reads the rule its camera zoom
 * falls in.
 */
export const LabelDistanceRules = {
  defaultScale,
  zoomRange,

  /**
   * Three rules. Up to zoom 13 the map is seen from afar and the labels reach
   * five times the camera's distance to the point it looks at. From zoom 14
   * the camera is among the streets and the labels reach a quarter past that
   * distance. From zoom 18 the camera stands so close to the ground that a
   * quarter past its distance ends a few houses away, and the labels reach
   * twice it.
   */
  default: Object.freeze([
    { firstZoom: 0, scale: 5 },
    { firstZoom: 14, scale: defaultScale },
    { firstZoom: 18, scale: 2 },
  ]) as readonly LabelDistanceRule[],

  /**
   * The rules as a frame reads them: first zooms inside the range, sorted,
   * one rule per first zoom, the first rule starting at zoom 0, no negative
   * or undefined reach, at least one rule.
   */
  normalized(rules: readonly LabelDistanceRule[]): LabelDistanceRule[] {
    const cleaned = rules.map((rule) => ({
      firstZoom: Math.min(Math.max(Math.trunc(rule.firstZoom), zoomRange[0]), zoomRange[1]),
      scale: Number.isNaN(rule.scale) ? defaultScale : Math.max(rule.scale, 0),
    }));
    cleaned.sort((a, b) => a.firstZoom - b.firstZoom);
    const unique: LabelDistanceRule[] = [];
    for (const rule of cleaned) {
      const last = unique[unique.length - 1];
      if (last === undefined || last.firstZoom < rule.firstZoom) unique.push(rule);
    }
    if (unique.length === 0) return [...LabelDistanceRules.default];
    unique[0] = { firstZoom: zoomRange[0], scale: unique[0]!.scale };
    return unique;
  },

  /** The zoom a frame's rule is chosen by: the camera zoom's whole part. */
  ruleZoom(cameraZoom: number): number {
    if (!Number.isFinite(cameraZoom)) return zoomRange[0];
    return Math.min(Math.max(zoomRange[0], Math.floor(cameraZoom)), zoomRange[1]);
  },

  /** The reach at a camera zoom, of normalized rules. */
  scale(rules: readonly LabelDistanceRule[], cameraZoom: number): number {
    const zoom = LabelDistanceRules.ruleZoom(cameraZoom);
    let found: LabelDistanceRule | undefined;
    for (const rule of rules) if (rule.firstZoom <= zoom) found = rule;
    return (found ?? rules[0])?.scale ?? defaultScale;
  },

  /** The last zoom of the rule at `index`, `undefined` for the last rule. */
  lastZoom(rules: readonly LabelDistanceRule[], index: number): number | undefined {
    const next = rules[index + 1];
    return next === undefined ? undefined : next.firstZoom - 1;
  },
} as const;
