// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * One rule of the flat map's coverage: the ground up to `distance` rings of
 * tiles from the look-at tile (and past the previous rule's rings) is drawn
 * `zoomDrop` levels below the target zoom, as geometry at every distance.
 */
export interface FlatRingRule {
  readonly zoomDrop: number;
  /**
   * In tiles of the target zoom, counted on the grid from the look-at tile:
   * 0 is that tile alone, 1 the three by three tiles around it, and so on.
   * A ring number, not a radius, so a rule's edge runs along tile edges.
   */
  readonly distance: number;
  /**
   * Whether the band's tiles draw their lines: the ground line ribbons
   * (rivers, borders) and every road bucket. Off, the band is fills only.
   */
  readonly drawsLines: boolean;
  /**
   * Whether the band's tiles draw their labels: the place and POI names, the
   * house numbers, the road names and signs, the water names. Off, the band
   * is unlabelled, so the far rings toward the horizon can be left to the
   * map.
   */
  readonly drawsLabels: boolean;
  /**
   * The edge, in texels, of the texture the band's tiles draw their ground
   * from, `undefined` for the ground as geometry. A tile's fills are drawn
   * into the texture each frame and the texture drawn as one grid, with its
   * mipmaps, which is what a far band wants: no shimmer. The lines are never
   * in the texture: with `drawsLines` they draw as geometry over it. One of
   * `FlatRingRules.rasterSizes`, and a cost of every frame, so a far band
   * wants a small one.
   */
  readonly rasterSize: number | undefined;
  /**
   * How many zooms coarser than the band's own tiles the ground reads its
   * terrain, on the relief: 0 reads the terrain tile of each tile's own zoom,
   * every height the source has that a grid can show, and n the terrain n
   * zooms coarser, one terrain tile under 4^n ground tiles. The near ring at
   * 0 is the mountain the camera stands at in full detail, and a far ring at
   * 3 or 4 rises from a handful of coarse tiles, which is all the texels it
   * has for them. One of `FlatRingRules.terrainZoomDropRange`. Nothing on
   * the plane.
   */
  readonly terrainZoomDrop: number;
}

/** The switches of a rule past its drop and distance, each with its default. */
export interface FlatRingRuleOptions {
  readonly drawsLines?: boolean;
  readonly drawsLabels?: boolean;
  readonly rasterSize?: number | undefined;
  readonly terrainZoomDrop?: number;
}

/** A rule, the switches left out taking their defaults (lines and labels on, geometry, the band's own terrain). */
export function flatRingRule(zoomDrop: number, distance: number, options: FlatRingRuleOptions = {}): FlatRingRule {
  return {
    zoomDrop,
    distance,
    drawsLines: options.drawsLines ?? true,
    drawsLabels: options.drawsLabels ?? true,
    rasterSize: options.rasterSize,
    terrainZoomDrop: options.terrainZoomDrop ?? 0,
  };
}

/**
 * The rules, nearest first. Any number of them. The debug panel edits the
 * list, and both surfaces read it: the plane through `FlatRingRuleCoverage`,
 * the sphere through `GlobeTileCoverage`, which reads every switch of a rule
 * as the plane does.
 */
export interface FlatRingRules {
  readonly rules: readonly FlatRingRule[];
}

const zoomDropRange = { lowerBound: 0, upperBound: 8 } as const;
const distanceRange = { lowerBound: 0, upperBound: 256 } as const;
const terrainZoomDropRange = { lowerBound: 0, upperBound: 8 } as const;
const rasterSizes: readonly number[] = Object.freeze([64, 128, 256, 512, 1024]);

function clampTo(value: number, range: { readonly lowerBound: number; readonly upperBound: number }): number {
  return Math.min(Math.max(value, range.lowerBound), range.upperBound);
}

function frozenRules(rules: FlatRingRule[]): FlatRingRules {
  return Object.freeze({ rules: Object.freeze(rules.map((rule) => Object.freeze(rule))) });
}

/**
 * The exact tiles to one ring around the look-at tile, as geometry with
 * their lines and labels, on the terrain of their own zoom. Past it the
 * ground is textures, without lines or labels: one level coarser to ring 2
 * and two levels coarser to ring 3 at 128 texels, four levels coarser to
 * ring 9 at 64. The terrain past the near ring is three zooms under the near
 * tiles' (zoom 10 at a zoom 13 frame), and the far band's seven under (zoom
 * 6), a few coarse tiles for the ridges toward the horizon. The ground beyond
 * is the horizon backdrop (`TileWorkingSet.horizonBackdrops`). The map
 * recedes toward the horizon soft and quiet, and the textures, drawn every
 * frame, stay small.
 */
const defaultRules = frozenRules([
  flatRingRule(0, 1),
  flatRingRule(1, 2, { drawsLines: false, drawsLabels: false, rasterSize: 128, terrainZoomDrop: 2 }),
  flatRingRule(2, 3, { drawsLines: false, drawsLabels: false, rasterSize: 128, terrainZoomDrop: 1 }),
  flatRingRule(4, 9, { drawsLines: false, drawsLabels: false, rasterSize: 64, terrainZoomDrop: 3 }),
]);

/**
 * The globe's zooms: the exact tiles with their lines to ring 1, then two
 * levels coarser to ring 3 as geometry, with their labels and without lines.
 * Ground past ring 3 is the pinned world cover (`GlobeTileCoverage`).
 */
const globeDefaultRules = frozenRules([flatRingRule(0, 1), flatRingRule(2, 3, { drawsLines: false })]);

/**
 * Zooms 15 and 16: the exact tiles with their lines and labels to ring 1,
 * one level coarser to ring 3 as 64-texel textures with their lines and
 * without labels, then four levels coarser to ring 13 as 128-texel textures,
 * without lines or labels.
 */
const nearStreetDefaultRules = frozenRules([
  flatRingRule(0, 1),
  flatRingRule(1, 3, { drawsLabels: false, rasterSize: 64 }),
  flatRingRule(4, 13, { drawsLines: false, drawsLabels: false, rasterSize: 128 }),
]);

/**
 * Zoom 17 and deeper: the exact tiles with their lines and labels to ring 1,
 * then two levels coarser to ring 2 as 128-texel textures, without lines or
 * labels, nothing beyond but the horizon backdrop.
 */
const closeStreetDefaultRules = frozenRules([flatRingRule(0, 1), flatRingRule(2, 2, { drawsLines: false, drawsLabels: false, rasterSize: 128 })]);

export const FlatRingRules = {
  zoomDropRange,
  distanceRange,
  /** How many zooms coarser than its tiles a band's terrain may be (`FlatRingRule.terrainZoomDrop`). */
  terrainZoomDropRange,
  /**
   * The texture edges a rule may draw its ground from
   * (`FlatRingRule.rasterSize`): powers of two, so every mip level halves the
   * one above it down to a single texel.
   */
  rasterSizes,

  default: defaultRules,
  globeDefault: globeDefaultRules,
  nearStreetDefault: nearStreetDefaultRules,
  closeStreetDefault: closeStreetDefaultRules,

  /** The allowed edge nearest to `size`, `undefined` for `undefined`. Of two as near, the smaller. */
  normalizedRasterSize(size: number | undefined): number | undefined {
    if (size === undefined) return undefined;
    let best: number | undefined;
    for (const candidate of rasterSizes) {
      if (best === undefined || Math.abs(candidate - size) < Math.abs(best - size)) best = candidate;
    }
    return best;
  },

  /**
   * The rules as the coverage reads them: every value inside its range,
   * sorted by distance, one rule per distance (the first of two at one
   * distance kept), at least one rule.
   */
  normalized(rules: FlatRingRules): FlatRingRules {
    const cleaned: FlatRingRule[] = rules.rules.map((rule) => ({
      zoomDrop: clampTo(rule.zoomDrop, zoomDropRange),
      distance: clampTo(rule.distance, distanceRange),
      drawsLines: rule.drawsLines,
      drawsLabels: rule.drawsLabels,
      rasterSize: FlatRingRules.normalizedRasterSize(rule.rasterSize),
      terrainZoomDrop: clampTo(rule.terrainZoomDrop, terrainZoomDropRange),
    }));
    // A stable sort, as the first of two rules at one distance is the one kept.
    cleaned.sort((lhs, rhs) => lhs.distance - rhs.distance);
    const unique: FlatRingRule[] = [];
    for (const rule of cleaned) {
      const last = unique.at(-1);
      if (last === undefined || last.distance < rule.distance) unique.push(rule);
    }
    if (unique.length === 0) return defaultRules;
    return { rules: unique };
  },

  ruleEquals(lhs: FlatRingRule, rhs: FlatRingRule): boolean {
    return (
      lhs.zoomDrop === rhs.zoomDrop &&
      lhs.distance === rhs.distance &&
      lhs.drawsLines === rhs.drawsLines &&
      lhs.drawsLabels === rhs.drawsLabels &&
      lhs.rasterSize === rhs.rasterSize &&
      lhs.terrainZoomDrop === rhs.terrainZoomDrop
    );
  },

  equals(lhs: FlatRingRules, rhs: FlatRingRules): boolean {
    if (lhs === rhs) return true;
    if (lhs.rules.length !== rhs.rules.length) return false;
    for (let index = 0; index < lhs.rules.length; index++) {
      if (!FlatRingRules.ruleEquals(lhs.rules[index]!, rhs.rules[index]!)) return false;
    }
    return true;
  },
} as const;

/**
 * One rule's band as the frame resolved it: its zoom, its last ring, how many
 * tiles it placed, and the zoom its ground reads its terrain at on the relief
 * (`FlatRingRule.terrainZoomDrop`).
 */
export interface FlatRingBand {
  readonly zoom: number;
  readonly distance: number;
  readonly tileCount: number;
  readonly terrainZoom: number;
}

/** A band. `terrainZoom` left out reads the band's own zoom. */
export function flatRingBand(zoom: number, distance: number, tileCount: number, terrainZoom?: number): FlatRingBand {
  return { zoom, distance, tileCount, terrainZoom: terrainZoom ?? zoom };
}
