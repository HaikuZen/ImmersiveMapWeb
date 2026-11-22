// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import { type RasterTileSpec, type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import type { CoveragePolygon } from "./coverage-polygon.ts";
import { type FlatRingBand, FlatRingRules, flatRingBand } from "./flat-ring-rules.ts";
import { FlatTileCoverage, type VisitCounter } from "./flat-tile-coverage.ts";

/** What the flat coverage resolved: the targets and, by `visibleTileKey`, the switches of the rules that placed them. */
export interface FlatRingRuleCoverageResolution {
  /** Finest first (`FlatTileCoverage.sorted`). */
  readonly targets: readonly VisibleTile[];
  readonly bands: readonly FlatRingBand[];
  /**
   * The targets placed by a rule that draws no lines
   * (`FlatRingRule.drawsLines`). A tile two bands share takes the nearer
   * band's answer.
   */
  readonly linelessTargets: ReadonlySet<string>;
  /** The targets placed by a rule that draws no labels (`FlatRingRule.drawsLabels`), the nearer band deciding as for the lines. */
  readonly unlabelledTargets: ReadonlySet<string>;
  /**
   * The targets placed by a rule that draws its ground from a texture
   * (`FlatRingRule.rasterSize`), with how it is baked, the nearer band
   * deciding as for the lines.
   */
  readonly rasterTargets: ReadonlyMap<string, RasterTileSpec>;
  /** How many tiles the enumeration looked at, for the diagnostics. */
  readonly visitedNodeCount: number;
}

const emptyResolution: FlatRingRuleCoverageResolution = Object.freeze({
  targets: [],
  bands: [],
  linelessTargets: new Set<string>(),
  unlabelledTargets: new Set<string>(),
  rasterTargets: new Map<string, RasterTileSpec>(),
  visitedNodeCount: 0,
});

/** A rectangle of the flat render world along the tile grid's axes. */
export interface FlatRingSquare {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * The flat map's coverage by ring rules (`FlatRingRules`): the ground in view
 * is cut into bands by the distance, in tiles, from the tile the camera looks
 * at, one band per rule, and each band is drawn at the rule's zoom.
 *
 * The look-at tile is the target zoom's tile under the point the camera
 * looks at (the render world's origin). A rule's square is that tile and
 * `distance` rings of target tiles around it, and a band's ground is the
 * frustum's footprint inside the rule's square and outside the previous
 * rule's. The look-at point stays where it is through a turn or a tilt of
 * the camera, and the squares run along the grid, so neither changes a
 * tile's rule: they change only what the footprint holds, as they must. A
 * pan moves the squares by whole tiles, when the look-at point crosses a
 * tile edge. A band's tiles are every tile of its zoom its ground meets, so
 * nothing outside the footprint is placed, and a coarse tile is placed for
 * the part of it that is in view. Where a coarse tile of a farther band
 * reaches under a nearer band, the nearer band's finer tiles are drawn over
 * it by the tile-priority stencil. Beyond the last rule's square nothing is
 * placed by the rules: the horizon backdrop is the ground there
 * (`TileWorkingSet.horizonBackdrops`).
 */
export const FlatRingRuleCoverage = {
  /**
   * How far a band's ground is drawn in from its squares' sides, in target
   * tiles: well over the polygon test's tolerance, far under anything a tile
   * could lie in.
   */
  edgeInsetInTargetTiles: 1e-3,

  /**
   * `backdropZoom` is the zoom no band goes down to (the bands stop one
   * above it), `undefined` for none. `rasterPolygon` is the footprint the
   * texture bands (the rules with a `rasterSize`) are placed over, the
   * footprint pushed out past the visible ground
   * (`CoverageSettings.rasterBandMarginShare`), so their tiles are in before
   * a turn of the camera brings them into view. `undefined` places them over
   * `polygon` like the rest.
   */
  resolve(
    flatRenderState: FlatRenderState,
    targetZoom: number,
    backdropZoom: number | undefined,
    rules: FlatRingRules,
    polygon: CoveragePolygon,
    rasterPolygon?: CoveragePolygon,
  ): FlatRingRuleCoverageResolution {
    if (targetZoom < 0) return emptyResolution;
    const floorZoom = Math.min(backdropZoom === undefined ? 0 : backdropZoom + 1, targetZoom);

    const placed = new Map<string, VisibleTile>();
    const linelessTargets = new Set<string>();
    const unlabelledTargets = new Set<string>();
    const rasterTargets = new Map<string, RasterTileSpec>();
    const bands: FlatRingBand[] = [];
    const visited: VisitCounter = { count: 0 };
    let innerSquare: FlatRingSquare | undefined;
    const inset = (flatRenderState.renderMapSize / 2 ** targetZoom) * FlatRingRuleCoverage.edgeInsetInTargetTiles;
    for (const rule of FlatRingRules.normalized(rules).rules) {
      const zoom = Math.max(floorZoom, targetZoom - rule.zoomDrop);
      const square = FlatRingRuleCoverage.square(rule.distance, targetZoom, flatRenderState);
      const tiles = new Map<string, VisibleTile>();
      const footprint = rule.rasterSize !== undefined ? (rasterPolygon ?? polygon) : polygon;
      for (const ground of FlatRingRuleCoverage.bandPolygons(footprint, square, innerSquare, inset)) {
        for (const tile of FlatTileCoverage.tiles(zoom, ground, flatRenderState, visited)) tiles.set(visibleTileKey(tile), tile);
      }
      const spec: RasterTileSpec | undefined = rule.rasterSize !== undefined ? { size: rule.rasterSize } : undefined;
      for (const key of tiles.keys()) {
        if (placed.has(key)) continue;
        if (!rule.drawsLines) linelessTargets.add(key);
        if (!rule.drawsLabels) unlabelledTargets.add(key);
        if (spec !== undefined) rasterTargets.set(key, spec);
      }
      for (const [key, tile] of tiles) placed.set(key, tile);
      bands.push(flatRingBand(zoom, rule.distance, tiles.size, Math.max(0, zoom - rule.terrainZoomDrop)));
      innerSquare = square;
    }
    return {
      targets: [...placed.values()].sort(FlatTileCoverage.compare),
      bands,
      linelessTargets,
      unlabelledTargets,
      rasterTargets,
      visitedNodeCount: visited.count,
    };
  },

  /**
   * The target zoom's tile under the look-at point, which is the render
   * world's origin: its column and row in the world copy the pan keeps under
   * the camera.
   */
  lookAtTile(targetZoom: number, flatRenderState: FlatRenderState): { x: number; y: number } {
    const tilesCount = 2 ** targetZoom;
    const half = flatRenderState.renderMapSize * 0.5;
    const tileSize = flatRenderState.renderMapSize / tilesCount;
    // The inverse of `ImmersiveMapProjection.flatTileOriginAndSize` at the
    // origin. The row index grows south while the world is y-up.
    const column = Math.floor((half - flatRenderState.pan[0] * half) / tileSize);
    const rowFromSouth = Math.floor((half + flatRenderState.pan[1] * half) / tileSize);
    const clamp = (value: number) => Math.min(Math.max(value, 0), tilesCount - 1);
    return { x: clamp(column), y: tilesCount - 1 - clamp(rowFromSouth) };
  },

  /** The look-at tile and `rings` rings of target tiles around it, in world units. */
  square(rings: number, targetZoom: number, flatRenderState: FlatRenderState): FlatRingSquare {
    const tile = FlatRingRuleCoverage.lookAtTile(targetZoom, flatRenderState);
    const origin = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, targetZoom, 0, flatRenderState.pan, flatRenderState.renderMapSize);
    const size = flatRenderState.renderMapSize / 2 ** targetZoom;
    const reach = rings * size;
    return { minX: origin[0] - reach, minY: origin[1] - reach, maxX: origin[0] + size + reach, maxY: origin[1] + size + reach };
  },

  /**
   * The footprint inside `square` and outside `innerSquare`: one convex piece
   * with no inner square, otherwise the frame's four strips (the two
   * full-height sides, then the top and the bottom between them), those of
   * them the footprint reaches. Every piece is drawn in by `inset`, so a
   * tile that only touches the band along an edge is not one of its tiles.
   */
  bandPolygons(polygon: CoveragePolygon, square: FlatRingSquare, innerSquare: FlatRingSquare | undefined, inset: number): CoveragePolygon[] {
    const outer: FlatRingSquare = {
      minX: square.minX + inset,
      minY: square.minY + inset,
      maxX: square.maxX - inset,
      maxY: square.maxY - inset,
    };
    const pieces: CoveragePolygon[] = [];
    if (innerSquare === undefined) {
      const piece = FlatRingRuleCoverage.clipped(polygon, outer);
      if (piece !== undefined) pieces.push(piece);
      return pieces;
    }
    const inner: FlatRingSquare = {
      minX: innerSquare.minX - inset,
      minY: innerSquare.minY - inset,
      maxX: innerSquare.maxX + inset,
      maxY: innerSquare.maxY + inset,
    };
    if (!(inner.minX > outer.minX || inner.maxX < outer.maxX || inner.minY > outer.minY || inner.maxY < outer.maxY)) return pieces;
    const strips: FlatRingSquare[] = [
      { minX: outer.minX, minY: outer.minY, maxX: inner.minX, maxY: outer.maxY },
      { minX: inner.maxX, minY: outer.minY, maxX: outer.maxX, maxY: outer.maxY },
      { minX: inner.minX, minY: inner.maxY, maxX: inner.maxX, maxY: outer.maxY },
      { minX: inner.minX, minY: outer.minY, maxX: inner.maxX, maxY: inner.minY },
    ];
    for (const strip of strips) {
      const piece = FlatRingRuleCoverage.clipped(polygon, strip);
      if (piece !== undefined) pieces.push(piece);
    }
    return pieces;
  },

  /** The polygon's part inside the rectangle, `undefined` when there is none. */
  clipped(polygon: CoveragePolygon, square: FlatRingSquare): CoveragePolygon | undefined {
    if (!(square.maxX > square.minX && square.maxY > square.minY)) return undefined;
    const centre: Vec2 = [(square.minX + square.maxX) / 2, (square.minY + square.maxY) / 2];
    const sides: readonly (readonly [Vec2, Vec2])[] = [
      [
        [square.minX, centre[1]],
        [square.minX, centre[1] + 1],
      ],
      [
        [square.maxX, centre[1]],
        [square.maxX, centre[1] + 1],
      ],
      [
        [centre[0], square.minY],
        [centre[0] + 1, square.minY],
      ],
      [
        [centre[0], square.maxY],
        [centre[0] + 1, square.maxY],
      ],
    ];
    let result: CoveragePolygon | undefined = polygon;
    for (const [a, b] of sides) {
      result = result?.clipped(centre, a, b);
    }
    return result;
  },
} as const;
