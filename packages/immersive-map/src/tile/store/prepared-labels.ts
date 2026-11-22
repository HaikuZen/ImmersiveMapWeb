// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The labels a prepared tile carries beside its arena, as the Wasm parser
 * writes them (crates/tile-parse `prepared_labels::TileLabelsMeta`, JSON in
 * camelCase): the CPU half of the Swift `PreparedTileArenaImage.TextLabelSetMeta`,
 * `RoadLabelsMeta` and `SurfaceLabelRecord`. The glyph quads are the arena's
 * label slots (`ArenaSlot` glyph, POI icon and route sign runs, the road
 * glyphs, the surface glyphs), 32 bytes a vertex (`labelVertexLayout`).
 *
 * Every position is in layout points (y up) unless it says otherwise: the
 * shaders scale it by the frame's pixels per point. A `u64` key is a decimal
 * string, since a JavaScript number cannot hold every 64-bit value. A zoom
 * at infinity (never, or every zoom) arrives as `null`.
 */

import type { Rgb } from "../../configuration/color.ts";
import type { LabelAppearance, RouteShieldShape } from "../../style/theme.ts";

/** One label vertex in the arena: byte offsets of its fields, 32 bytes in all (the Swift `LabelVertex`). */
export const labelVertexLayout = {
  stride: 32,
  /** `vec2f`, layout points (y up), or a surface label's anchor in tile render units. */
  position: 0,
  /** `vec2f`, the atlas UV, or a route sign plate's size in points. */
  uv: 8,
  /** `i32`: the label's index in its set, a road glyph's index among the tile's placed glyphs. */
  labelIndex: 16,
  /** `vec2f`: a POI sprite's corner, a plate's corner, a surface glyph's offset from its anchor in points. */
  spriteUV: 24,
} as const;

/** How a label's text is drawn (the Swift `LabelTextStyle`): the appearance with the run identity and the globe's colours. */
export interface PreparedLabelTextStyle extends LabelAppearance {
  /** The style identity the runs are grouped by. */
  readonly key: number;
  /** Whether the label is a POI's name, which fades with the POIs. */
  readonly isPointOfInterest: boolean;
  /** The fill and the halo the label wears on the globe, null for its own. */
  readonly sphereFillColor: Rgb | null;
  readonly sphereStrokeColor: Rgb | null;
}

/** What the frame places and collides a screen label by (the Swift `TextLabelPlacementInput`). */
export interface TextLabelPlacementInput {
  /** The anchor as a share of the tile, (0, 0) at its north-west corner. */
  readonly uv: readonly [number, number];
  /** The roof over the anchor in tile units (a 4096 extent), zero on open ground. */
  readonly roofHeight: number;
  /** Whether the label draws on that roof rather than on the ground. */
  readonly liftsToRoof: boolean;
  /** The label's identity across tiles and zooms, a u64 as a decimal string. */
  readonly key: string;
  readonly sortKey: number;
  readonly collisionPriority: number;
  /** The collision box in layout points. */
  readonly labelSizePoints: readonly [number, number];
  /** The camera zoom the label shows from, 0 for always. */
  readonly minCameraZoom: number;
  /** The camera zoom it goes away at, null for never. */
  readonly maxCameraZoom: number | null;
  /** Local detail, shown only near the camera. */
  readonly isLocal: boolean;
}

/** The look of one run of route sign plates (the Swift `RouteShieldRunStyle`), the em fractions resolved to points. */
export interface RouteShieldRunStyle {
  readonly shape: RouteShieldShape;
  readonly fillColor: Rgb;
  readonly borderColor: Rgb;
  /** The band across the top, null for a plate in one colour. */
  readonly headerColor: Rgb | null;
  /** The band's height as a share of the plate's, zero without a band. */
  readonly headerFraction: number;
  readonly borderWidthPoints: number;
  readonly cornerRadiusPoints: number;
}

/**
 * The screen labels, one set: a vertex's `labelIndex` is its label's index
 * in `placementInputs`. The run styles are in the arena's slot order: glyph
 * runs (one atlas each, by `weight`), POI icon runs, route sign plate runs.
 */
export interface TextLabelSetMeta {
  /** By the zoom the labels show from, then collision priority, then sort key. */
  readonly placementInputs: readonly TextLabelPlacementInput[];
  readonly glyphRunStyles: readonly PreparedLabelTextStyle[];
  readonly poiIconRunStyles: readonly PreparedLabelTextStyle[];
  readonly routeShieldRunStyles: readonly RouteShieldRunStyle[];
}

export interface IndexRange {
  readonly start: number;
  readonly count: number;
}

export interface RoadPathRange extends IndexRange {
  readonly labelIndex: number;
}

export interface RoadPathLabel {
  readonly text: string;
  /** A u64 as a decimal string. */
  readonly key: string;
}

/** An anchor of a road label: the segment of its path, the parameter along it, its ordinal among the label's anchors. */
export interface RoadLabelAnchor {
  readonly pathIndex: number;
  readonly segmentIndex: number;
  readonly t: number;
  readonly anchorOrdinal: number;
}

/**
 * The road names (the Swift `RoadLabelsMeta`). Each path label's glyphs are
 * laid out once on the baseline (`glyphBounds`) and drawn again for each of
 * its anchors: the road glyph slot holds, anchor after anchor, six vertices
 * per glyph, a glyph's `labelIndex` its index among all the tile's placed glyphs.
 */
export interface RoadLabelsMeta {
  /** Every path's points as shares of the tile, (0, 0) north-west. */
  readonly pathInputs: readonly (readonly [number, number])[];
  readonly pathRanges: readonly RoadPathRange[];
  readonly pathLabels: readonly RoadPathLabel[];
  /** The style every road glyph of the tile draws with, null for a tile without road names. */
  readonly labelStyle: PreparedLabelTextStyle | null;
  /** Each glyph's box about the baseline: min x, max x, min y, max y. */
  readonly glyphBounds: readonly (readonly [number, number, number, number])[];
  /** Each path label's glyphs in `glyphBounds`. */
  readonly glyphBoundRanges: readonly IndexRange[];
  /** Each path label's laid-out size. */
  readonly sizes: readonly (readonly [number, number])[];
  /** Each path label's anchors in `anchors`. */
  readonly anchorRanges: readonly IndexRange[];
  readonly anchors: readonly RoadLabelAnchor[];
}

/** How a label painted on the map scales and when it shows (the Swift `SurfaceLabelPlacement`). */
export interface SurfaceLabelPlacement {
  /** The camera zoom from which the text grows with the map. */
  readonly referenceZoom: number;
  /** The zooms it shows at, null for no bound (minus or plus infinity). */
  readonly minimumZoom: number | null;
  readonly maximumZoom: number | null;
  readonly letterSpacingEm: number;
}

/**
 * One name painted on the map (the Swift `SurfaceLabelRecord`): its glyph
 * quads in the surface slot, a vertex's `position` the anchor in tile render
 * units (y up), its `spriteUV` the offset from the anchor in points.
 */
export interface SurfaceLabelRecord {
  /** A u64 as a decimal string: one copy of a key draws per frame. */
  readonly key: string;
  readonly style: PreparedLabelTextStyle;
  readonly placement: SurfaceLabelPlacement;
  readonly vertexStart: number;
  readonly vertexCount: number;
}

/** The label part of a tile's metadata. */
export interface TileLabelsMeta {
  readonly text: TextLabelSetMeta;
  readonly road: RoadLabelsMeta;
  readonly surface: readonly SurfaceLabelRecord[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isArray = Array.isArray;

/**
 * Whether metadata's labels have the shape the parser writes: the three
 * parts and their arrays, the run styles as many as the arena's text runs.
 * The records themselves are the parser's and are not walked one by one;
 * the spans they point into are checked at the upload (`createGpuTile`).
 */
export function isTileLabelsMeta(value: unknown, counts: { glyphRunCount: number; poiIconRunCount: number; routeShieldRunCount: number }): value is TileLabelsMeta {
  if (!isObject(value) || !isObject(value.text) || !isObject(value.road) || !isArray(value.surface)) return false;
  const { text, road } = value;
  if (!isArray(text.placementInputs) || !isArray(text.glyphRunStyles) || !isArray(text.poiIconRunStyles) || !isArray(text.routeShieldRunStyles)) return false;
  if (text.glyphRunStyles.length !== counts.glyphRunCount || text.poiIconRunStyles.length !== counts.poiIconRunCount || text.routeShieldRunStyles.length !== counts.routeShieldRunCount) return false;
  const roadArrays = [road.pathInputs, road.pathRanges, road.pathLabels, road.glyphBounds, road.glyphBoundRanges, road.sizes, road.anchorRanges, road.anchors];
  if (!roadArrays.every(isArray)) return false;
  return road.labelStyle === null || isObject(road.labelStyle);
}

/** A tile without labels: what a test or an empty tile's metadata holds. */
export function emptyTileLabelsMeta(): TileLabelsMeta {
  return {
    text: { placementInputs: [], glyphRunStyles: [], poiIconRunStyles: [], routeShieldRunStyles: [] },
    road: { pathInputs: [], pathRanges: [], pathLabels: [], labelStyle: null, glyphBounds: [], glyphBoundRanges: [], sizes: [], anchorRanges: [], anchors: [] },
    surface: [],
  };
}
