// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "../../math/vec.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { DebugFrameReport } from "../../render/debug/debug-frame-report.ts";
import type { PlaceTile, ResidentTile } from "../../tile/placement/place-tile.ts";
import type { Tile } from "../../tile/tile.ts";
import { CoveragePolygonBuilder } from "../../tile/visibility/coverage-polygon.ts";

/** An axis-aligned rectangle, the `CGRect` of the Swift coverage maps: origin at the minimum corner. */
export interface DebugRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The smallest rectangle holding both (`CGRect.union` of two non-null rects). */
export function debugRectUnion(a: DebugRect, b: DebugRect): DebugRect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** One placement of the frame on the coverage map. */
export interface DebugOverlayTileCoveragePlacement {
  /** The slot drawn: its square and its colour. */
  readonly slot: Tile;
  /** The tile drawn in it: the slot's own, or a coarser stand-in. */
  readonly source: Tile;
  readonly worldWrap: number;
}

export const DebugOverlayTileCoveragePlacement = {
  isStandIn(placement: DebugOverlayTileCoveragePlacement): boolean {
    const { slot, source } = placement;
    return slot.x !== source.x || slot.y !== source.y || slot.z !== source.z;
  },

  /** The slot's square in normalized Mercator. */
  square(placement: DebugOverlayTileCoveragePlacement): DebugRect {
    const count = 2 ** placement.slot.z;
    return { x: placement.slot.x / count + placement.worldWrap, y: placement.slot.y / count, width: 1 / count, height: 1 / count };
  },
} as const;

/**
 * The frame's tile coverage seen from above, for the debug panel's coverage
 * map (the Swift `DebugOverlayTileCoverage`): every placement as the square
 * of its slot, the ground footprint of the view, the point the camera looks
 * at and the eye, all in normalized Mercator (x east and y south, the world
 * one unit wide, a copy of the world to the east one unit further). The map
 * draws the rings as they are, nested bands of squares round the look-at
 * point, which the perspective of the map itself folds into a few pixels at
 * the horizon.
 */
export interface DebugOverlayTileCoverage {
  readonly placements: readonly DebugOverlayTileCoveragePlacement[];
  /** The ground footprint of the view, a convex polygon, empty on the globe. */
  readonly footprint: readonly Vec2[];
  /** The point the camera looks at. */
  readonly center: Vec2;
  /** Where the eye stands over the ground, `undefined` on the globe. */
  readonly eye: Vec2 | undefined;
}

export const DebugOverlayTileCoverage = {
  /** The frame's coverage: the flat map's footprint and eye, the globe's placements alone. */
  make(
    report: Pick<DebugFrameReport, "placements" | "mapCameraState" | "renderSurfaceMode" | "flatRenderState" | "projectionView" | "cameraEye">,
  ): DebugOverlayTileCoverage {
    const placements = DebugOverlayTileCoverage.placements(report.placements);
    const center = report.mapCameraState.centerWorldMercator;
    if (report.renderSurfaceMode !== "flat") return { placements, footprint: [], center, eye: undefined };
    const flat = report.flatRenderState;
    const polygon = CoveragePolygonBuilder.make(report.projectionView);
    const footprint = polygon === undefined ? [] : polygon.vertices.map((vertex) => DebugOverlayTileCoverage.mercator(vertex, flat));
    const eye = DebugOverlayTileCoverage.mercator([report.cameraEye[0], report.cameraEye[1]], flat);
    return { placements, footprint, center, eye };
  },

  /**
   * The frame's placements as the map shows them, without the flat map's
   * horizon backdrop (`PlaceTile.isHorizonBackdrop`): the world tile under
   * everything is no ground of the planner's, and its square, the whole
   * world, would be the map's window, with the placements the map is there
   * to show a few pixels in it.
   */
  placements(placeTiles: readonly PlaceTile<ResidentTile>[]): DebugOverlayTileCoveragePlacement[] {
    const placements: DebugOverlayTileCoveragePlacement[] = [];
    for (const placeTile of placeTiles) {
      if (placeTile.isHorizonBackdrop) continue;
      placements.push({ slot: placeTile.placeIn.tile, source: placeTile.resident.tile, worldWrap: placeTile.placeIn.worldWrap });
    }
    return placements;
  },

  /**
   * A point of the flat render world (y up, the world `renderMapSize` wide
   * and panned by `pan`) in normalized Mercator: the inverse of
   * `ImmersiveMapProjection.flatTileOriginAndSize` at zoom 0.
   */
  mercator(point: Vec2, flatRenderState: FlatRenderState): Vec2 {
    const size = flatRenderState.renderMapSize;
    const half = size * 0.5;
    const x = (point[0] + half - flatRenderState.pan[0] * half) / size;
    const y = 1 - (point[1] + half + flatRenderState.pan[1] * half) / size;
    return [x, y];
  },
} as const;

/**
 * The geometry of the coverage map (the Swift
 * `DebugOverlayTileCoverageLayout`), shared by the panel views that draw it:
 * the window of Mercator it shows and where a point of Mercator lands in it.
 */
export const DebugOverlayTileCoverageLayout = {
  side: 280,
  margin: 0.06,
  cornerRadius: 8,
  tileLineWidth: 1.5,
  tileFillAlpha: 0.26,
  footprintLineWidth: 1.5,
  footprintFillAlpha: 0.08,
  markerRadius: 3.5,
  labelFontSize: 9,
  /** A slot square narrower than this on the map carries no label. */
  labelledSquareSide: 44,
  sourceLabelledSquareSide: 60,

  /**
   * The square of Mercator shown: the bounds of every slot and of the point
   * the camera looks at, widened by `margin`, squared round its centre, so
   * the map is never stretched and the north stays up. The footprint is left
   * out on purpose: a camera on the horizon sees to the far plane, and a
   * window round that put the tiles in a corner a few pixels wide. It is cut
   * at the window's edge instead.
   */
  window(coverage: DebugOverlayTileCoverage): DebugRect {
    let bounds: DebugRect = { x: coverage.center[0], y: coverage.center[1], width: 0, height: 0 };
    for (const placement of coverage.placements) bounds = debugRectUnion(bounds, DebugOverlayTileCoveragePlacement.square(placement));
    return squareWindow(bounds, coverage.center);
  },

  /** Where a point of Mercator lands in a map of `side` points, y down as Mercator's. */
  point(mercator: Vec2, window: DebugRect, side: number): Vec2 {
    const scale = side / Math.max(window.width, 1e-12);
    return [(mercator[0] - window.x) * scale, (mercator[1] - window.y) * scale];
  },

  rect(square: DebugRect, window: DebugRect, side: number): DebugRect {
    const origin = DebugOverlayTileCoverageLayout.point([square.x, square.y], window, side);
    const scale = side / Math.max(window.width, 1e-12);
    return { x: origin[0], y: origin[1], width: square.width * scale, height: square.height * scale };
  },

  /** The placements in drawing order: the coarse slots first, so a fine slot lies on the coarse one it splits. */
  drawingOrder(placements: readonly DebugOverlayTileCoveragePlacement[]): DebugOverlayTileCoveragePlacement[] {
    return [...placements].sort((a, b) => a.slot.z - b.slot.z || a.slot.x - b.slot.x || a.slot.y - b.slot.y);
  },
} as const;

/** `bounds` widened by the margin and squared round its centre, or the world round `center` for empty bounds. */
export function squareWindow(bounds: DebugRect, center: Vec2): DebugRect {
  if (!(bounds.width > 0 || bounds.height > 0)) return { x: center[0] - 0.5, y: center[1] - 0.5, width: 1, height: 1 };
  const side = Math.max(bounds.width, bounds.height) * (1 + DebugOverlayTileCoverageLayout.margin * 2);
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  return { x: midX - side / 2, y: midY - side / 2, width: side, height: side };
}
