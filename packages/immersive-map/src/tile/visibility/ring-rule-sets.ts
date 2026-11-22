// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { FlatRingRules } from "./flat-ring-rules.ts";

/** One stretch of target zooms and the ring rules it is drawn by: from `firstZoom` up to the zoom before the next set's first. */
export interface RingRuleSet {
  readonly firstZoom: number;
  readonly rules: FlatRingRules;
}

/**
 * The ring rules by target zoom: any number of sets, each owning the zooms
 * from its first to the next set's, the last one to the deepest zoom. A
 * frame reads the set its zoom falls in, so the globe's zooms and the street
 * zooms take different rules. The debug panel edits the list.
 */
export interface RingRuleSets {
  readonly sets: readonly RingRuleSet[];
}

const zoomRange = { lowerBound: 0, upperBound: 22 } as const;

/**
 * The target zooms the sphere and its unroll are drawn at under the default
 * presentation settings, which finish the unroll at zoom 7.
 */
const defaultStreetFirstZoom = 7;
/** The first zoom of the near street set, where the camera comes down among the buildings. */
const defaultNearStreetFirstZoom = 15;
/** The first zoom of the closest street set. */
const defaultCloseStreetFirstZoom = 17;

/**
 * Four sets. The globe's zooms step down fast and drop their lines early,
 * since toward the limb a tile is seen edge on. The zooms past the unroll
 * take the plane's rules (`FlatRingRules.default`). Among the buildings
 * (`FlatRingRules.nearStreetDefault`) and closer still
 * (`FlatRingRules.closeStreetDefault`) the near rings are tighter, and every
 * set past the globe's draws its far rings from textures
 * (`FlatRingRule.rasterSize`). Beyond every set's last rule the plane is the
 * horizon backdrop (`TileWorkingSet.horizonBackdrops`).
 */
const defaultSets: RingRuleSets = Object.freeze({
  sets: Object.freeze([
    Object.freeze({ firstZoom: 0, rules: FlatRingRules.globeDefault }),
    Object.freeze({ firstZoom: defaultStreetFirstZoom, rules: FlatRingRules.default }),
    Object.freeze({ firstZoom: defaultNearStreetFirstZoom, rules: FlatRingRules.nearStreetDefault }),
    Object.freeze({ firstZoom: defaultCloseStreetFirstZoom, rules: FlatRingRules.closeStreetDefault }),
  ]),
});

/**
 * The normalized form of each sets value a frame has asked about. The values
 * are immutable, so a frame that reads the same sets again (every frame
 * does) normalizes nothing.
 */
const normalizedCache = new WeakMap<RingRuleSets, RingRuleSets>();

export const RingRuleSets = {
  zoomRange,
  defaultStreetFirstZoom,
  defaultNearStreetFirstZoom,
  defaultCloseStreetFirstZoom,
  default: defaultSets,

  /**
   * The sets as a frame reads them: first zooms inside the range, sorted,
   * one set per first zoom, the first set starting at zoom 0, every set's
   * rules normalized, at least one set.
   */
  normalized(ringRuleSets: RingRuleSets): RingRuleSets {
    const cached = normalizedCache.get(ringRuleSets);
    if (cached !== undefined) return cached;
    const cleaned: RingRuleSet[] = ringRuleSets.sets.map((set) => ({
      firstZoom: Math.min(Math.max(set.firstZoom, zoomRange.lowerBound), zoomRange.upperBound),
      rules: FlatRingRules.normalized(set.rules),
    }));
    cleaned.sort((lhs, rhs) => lhs.firstZoom - rhs.firstZoom);
    const unique: RingRuleSet[] = [];
    for (const set of cleaned) {
      const last = unique.at(-1);
      if (last === undefined || last.firstZoom < set.firstZoom) unique.push(set);
    }
    let result: RingRuleSets;
    if (unique.length === 0) {
      result = defaultSets;
    } else {
      unique[0] = { firstZoom: zoomRange.lowerBound, rules: unique[0]!.rules };
      result = { sets: unique };
    }
    normalizedCache.set(ringRuleSets, result);
    return result;
  },

  /** The index of the set `zoom` falls in, of normalized sets. The frame asks by its camera zoom (`FrameVisibilityResolver`). */
  setIndex(ringRuleSets: RingRuleSets, zoom: number): number {
    for (let index = ringRuleSets.sets.length - 1; index >= 0; index--) {
      if (ringRuleSets.sets[index]!.firstZoom <= zoom) return index;
    }
    return 0;
  },

  /** The rules a frame at camera zoom `zoom` is drawn by. */
  rulesForZoom(ringRuleSets: RingRuleSets, zoom: number): FlatRingRules {
    const normalized = RingRuleSets.normalized(ringRuleSets);
    return normalized.sets[RingRuleSets.setIndex(normalized, zoom)]!.rules;
  },

  /** The last zoom of the set at `index`, `undefined` for the last set. */
  lastZoom(ringRuleSets: RingRuleSets, index: number): number | undefined {
    const next = index + 1 >= 0 ? ringRuleSets.sets[index + 1] : undefined;
    return next === undefined ? undefined : next.firstZoom - 1;
  },
} as const;
