// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "../../math/vec.ts";
import type { GroundReliefStatusSnapshot, GroundReliefTileState } from "../../tile/relief/store/ground-relief-status-snapshot.ts";
import type { Tile } from "../../tile/tile.ts";
import { type DebugOverlayTileCoverage, type DebugRect, debugRectUnion, squareWindow } from "./debug-overlay-tile-coverage.ts";

/** One terrain tile on the relief tab's map. */
export interface DebugOverlayReliefCoverageSquare {
  readonly tile: Tile;
  readonly state: GroundReliefTileState;
  /** Wanted by the frame, as opposed to kept from earlier frames. */
  readonly isWanted: boolean;
}

export const DebugOverlayReliefCoverageSquare = {
  square(square: DebugOverlayReliefCoverageSquare): DebugRect {
    const count = 2 ** square.tile.z;
    return { x: square.tile.x / count, y: square.tile.y / count, width: 1 / count, height: 1 / count };
  },
} as const;

/**
 * The terrain seen from above, for the relief tab's coverage map (the Swift
 * `DebugOverlayReliefCoverage`): every terrain tile the store lists
 * (`GroundReliefStatusSnapshot`) as its square, by its state, the frame's
 * wanted ones drawn strong and the ones kept from earlier frames faint, over
 * the view's footprint, the point the camera looks at and the eye of the
 * tiles' coverage map (`DebugOverlayTileCoverage`). Normalized Mercator, as
 * that map.
 */
export interface DebugOverlayReliefCoverage {
  readonly squares: readonly DebugOverlayReliefCoverageSquare[];
  readonly footprint: readonly Vec2[];
  readonly center: Vec2;
  readonly eye: Vec2 | undefined;
}

export const DebugOverlayReliefCoverage = {
  make(status: GroundReliefStatusSnapshot, view: DebugOverlayTileCoverage): DebugOverlayReliefCoverage {
    return {
      squares: status.tiles.map((tile) => ({ tile: tile.tile, state: tile.state, isWanted: tile.priority !== undefined })),
      footprint: view.footprint,
      center: view.center,
      eye: view.eye,
    };
  },

  /**
   * The square of Mercator shown: the wanted tiles and the point looked at,
   * as the tiles' map frames its slots (`DebugOverlayTileCoverageLayout.window`).
   * A kept tile out of it is cut at its edge.
   */
  window(coverage: DebugOverlayReliefCoverage): DebugRect {
    let bounds: DebugRect = { x: coverage.center[0], y: coverage.center[1], width: 0, height: 0 };
    for (const square of coverage.squares) {
      if (square.isWanted) bounds = debugRectUnion(bounds, DebugOverlayReliefCoverageSquare.square(square));
    }
    return squareWindow(bounds, coverage.center);
  },

  /** The squares in drawing order: the kept under the wanted, the coarse under the fine. */
  drawingOrder(coverage: DebugOverlayReliefCoverage): DebugOverlayReliefCoverageSquare[] {
    return [...coverage.squares].sort(
      (a, b) => Number(a.isWanted) - Number(b.isWanted) || a.tile.z - b.tile.z || a.tile.x - b.tile.x || a.tile.y - b.tile.y,
    );
  },
} as const;
