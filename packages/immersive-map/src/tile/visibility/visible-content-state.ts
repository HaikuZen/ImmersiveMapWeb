// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "../../math/vec.ts";
import type { RasterTileSpec, VisibleTile } from "../placement/place-tile.ts";
import type { FlatRingBand } from "./flat-ring-rules.ts";

/** The point the camera looks at in fractional tiles of the target zoom: x east, y south. */
export interface Center {
  readonly tileX: number;
  readonly tileY: number;
}

/**
 * The frame's coverage as the working set reads it (`TileCulling`). The
 * sets and the map are keyed by `visibleTileKey`.
 */
export interface VisibleContentState {
  readonly centerWorldMercator: Vec2;
  readonly center: Center;
  /**
   * The coverage targets: the tiles the frame draws, at the zoom their place
   * on screen wants (`TileCulling`), finest first.
   */
  readonly visibleTiles: readonly VisibleTile[];
  readonly tileZoomLevel: number;
  /** Moves when the targets or their rasters differ from the last frame's: the working set gates on it. */
  readonly coverageVersion: number;
  /**
   * The ring rules' bands, nearest first (`FlatRingRuleCoverage` on the
   * plane, `GlobeTileCoverage` on the sphere): each rule's zoom, last ring
   * and tile count.
   */
  readonly flatRingBands: readonly FlatRingBand[];
  /** The targets a rule that draws no lines placed (`FlatRingRule.drawsLines`), on either surface. */
  readonly linelessTiles: ReadonlySet<string>;
  /** The targets a rule that draws no labels placed (`FlatRingRule.drawsLabels`), on either surface. */
  readonly unlabelledTiles: ReadonlySet<string>;
  /**
   * The targets a rule that draws its ground from a texture placed
   * (`FlatRingRule.rasterSize`), with how each is baked, on either surface.
   * Such a target's ground is its raster or nothing, and its vector tile is
   * wanted only for what it draws over the raster (its lines and labels) or
   * to bake the raster from.
   */
  readonly rasterTiles: ReadonlyMap<string, RasterTileSpec>;
}

const noKeys: ReadonlySet<string> = new Set<string>();
const noRasters: ReadonlyMap<string, RasterTileSpec> = new Map<string, RasterTileSpec>();

export const VisibleContentState = {
  empty: Object.freeze({
    centerWorldMercator: Object.freeze([0.5, 0.5] as const),
    center: Object.freeze({ tileX: 0, tileY: 0 }),
    visibleTiles: Object.freeze([]),
    tileZoomLevel: 0,
    coverageVersion: 0,
    flatRingBands: Object.freeze([]),
    linelessTiles: noKeys,
    unlabelledTiles: noKeys,
    rasterTiles: noRasters,
  }) as VisibleContentState,

  /** A state with no bands and no switches: every target draws as geometry, with its lines and labels. */
  make(centerWorldMercator: Vec2, center: Center, visibleTiles: readonly VisibleTile[], tileZoomLevel: number, coverageVersion: number): VisibleContentState {
    return {
      centerWorldMercator,
      center,
      visibleTiles,
      tileZoomLevel,
      coverageVersion,
      flatRingBands: [],
      linelessTiles: noKeys,
      unlabelledTiles: noKeys,
      rasterTiles: noRasters,
    };
  },
} as const;
