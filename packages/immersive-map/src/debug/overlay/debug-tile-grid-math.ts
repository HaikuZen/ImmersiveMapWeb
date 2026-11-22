// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "../../math/vec.ts";
import type { Tile } from "../../tile/tile.ts";

/** Rectangle in tile UV, used for a cell and for the plate laid under a cell's stamp. */
export interface TileGridUVRect {
  readonly minU: number;
  readonly minV: number;
  readonly maxU: number;
  readonly maxV: number;
}

/**
 * One grid line piece in tile UV space, flagged as the tile's own border or
 * an interior division so the two can be drawn at different thicknesses.
 */
export interface TileGridLineSegment {
  readonly start: Vec2;
  readonly end: Vec2;
  readonly isBorder: boolean;
}

/** Inclusive tile-local bounds of a cell along one axis. */
export interface TileGridCellBounds {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Geometry and stamps of the debug tile grid (the Swift `DebugTileGridMath`):
 * the overlay that divides the tile under the camera centre into
 * `density x density` cells and writes over each cell which slice of that
 * tile's geometry it covers.
 *
 * Coordinate convention, which is the whole point of the overlay: the bounds
 * a cell prints are tile space (raw `.mvt` units, y south from the north
 * edge), exactly what a tile decoder, a grep over tile bodies or the
 * pipeline's GeoJSON shows, so a stamp can be pasted into any of them
 * unchanged.
 *
 * A cell code is the same box spelled differently: the letter is the column
 * index counted from the west (A is x 0 upward), the number is the row index
 * counted from the north starting at one (1 is y 0 downward), reading like
 * the rows of a table. So `C4` at density six is exactly
 * `x1365-2047 y2048-2730`, and either half of the stamp is enough to find the
 * geometry.
 *
 * Tile UV, which the projector takes, runs the same way: `uv.y = 0` is the
 * north edge on the flat map and on the globe, so `cellUVRect` maps the row
 * index straight through.
 */
export const DebugTileGridMath = {
  /** Tile-local extent the stamps are expressed in: the vector tiles' 4096 units a side. */
  tileExtent: 4096,

  /**
   * The `density + 1` lines each way, each cut into `segmentCountPerEdge`
   * pieces so that on the globe a line follows the sphere instead of cutting
   * through it.
   */
  makeGridSegments(density: number, segmentCountPerEdge: number): TileGridLineSegment[] {
    const clampedDensity = Math.max(1, density);
    const clampedSegments = Math.max(1, segmentCountPerEdge);
    const lineStep = 1.0 / clampedDensity;
    const pieceStep = 1.0 / clampedSegments;
    const segments: TileGridLineSegment[] = [];
    for (let lineIndex = 0; lineIndex <= clampedDensity; lineIndex++) {
      const position = Math.min(lineIndex * lineStep, 1.0);
      const isBorder = lineIndex === 0 || lineIndex === clampedDensity;
      for (let pieceIndex = 0; pieceIndex < clampedSegments; pieceIndex++) {
        const from = pieceIndex * pieceStep;
        const to = (pieceIndex + 1) * pieceStep;
        segments.push({ start: [position, from], end: [position, to], isBorder });
        segments.push({ start: [from, position], end: [to, position], isBorder });
      }
    }
    return segments;
  },

  /**
   * Inclusive tile-local bounds of one cell along an axis. Densities that do
   * not divide 4096 evenly (six does not) get the rounded partition, so cells
   * still tile 0...4095 with no gap and no overlap.
   */
  cellBounds(index: number, density: number): TileGridCellBounds {
    const clampedDensity = Math.max(1, density);
    const clampedIndex = Math.min(Math.max(index, 0), clampedDensity - 1);
    const extent = DebugTileGridMath.tileExtent;
    const lo = roundHalfAwayFromZero((clampedIndex * extent) / clampedDensity);
    const next = roundHalfAwayFromZero(((clampedIndex + 1) * extent) / clampedDensity);
    return { lo, hi: next - 1 };
  },

  /** Column letter from the west plus row number from the north, one-based. */
  cellCode(column: number, row: number): string {
    return `${columnLetters(column)}${Math.max(0, row) + 1}`;
  },

  /**
   * The four lines stamped over a cell: the tile it belongs to, the cell
   * code, and the cell's tile-local x and y bounds. Each cell is
   * self-sufficient on purpose, so a screenshot cropped to one cell still
   * says where to look.
   *
   * A fifth `src` line appears when the slot is drawn with a substitute
   * tile's geometry, because then the pixels under the stamp were not built
   * from the tile the first line names: they come from `sourceTile`, drawn
   * into the slot. Without the line the stamp would point at a tile that is
   * not on screen.
   */
  cellLabelLines(tile: Tile, column: number, row: number, density: number, sourceTile?: Tile): string[] {
    const xBounds = DebugTileGridMath.cellBounds(column, density);
    const yBounds = DebugTileGridMath.cellBounds(row, density);
    const lines = [`${tile.x}/${tile.y}/${tile.z}`, DebugTileGridMath.cellCode(column, row), `x${xBounds.lo}-${xBounds.hi}`, `y${yBounds.lo}-${yBounds.hi}`];
    if (sourceTile !== undefined && (sourceTile.x !== tile.x || sourceTile.y !== tile.y || sourceTile.z !== tile.z)) {
      lines.push(`src ${sourceTile.x}/${sourceTile.y}/${sourceTile.z}`);
    }
    return lines;
  },

  /**
   * The cell's rectangle in tile UV. The row index and `uv.y` both count
   * from the north, so the mapping is straight: row 0 is the top band.
   */
  cellUVRect(column: number, row: number, density: number): TileGridUVRect {
    const clampedDensity = Math.max(1, density);
    const step = 1.0 / clampedDensity;
    const clampedColumn = Math.min(Math.max(column, 0), clampedDensity - 1);
    const clampedRow = Math.min(Math.max(row, 0), clampedDensity - 1);
    return { minU: clampedColumn * step, minV: clampedRow * step, maxU: (clampedColumn + 1) * step, maxV: (clampedRow + 1) * step };
  },

  /**
   * The plate laid under a cell's stamp: the union of the laid-out lines,
   * grown by `paddingUV`. Every line is centred on its own anchor and spans
   * twice its half size, so the union is the smallest rectangle that covers
   * the text and nothing else. Kept tight on purpose: the plate exists to
   * keep map labels from muddying the stamp, not to hide the tile it is
   * drawn on.
   */
  makeStampPlate(lineAnchors: readonly Vec2[], lineHalfSizes: readonly Vec2[], paddingUV: number): TileGridUVRect | undefined {
    if (lineAnchors.length === 0 || lineAnchors.length !== lineHalfSizes.length) return undefined;
    let minU = Number.MAX_VALUE;
    let minV = Number.MAX_VALUE;
    let maxU = -Number.MAX_VALUE;
    let maxV = -Number.MAX_VALUE;
    for (let index = 0; index < lineAnchors.length; index++) {
      const anchor = lineAnchors[index]!;
      const halfSize = lineHalfSizes[index]!;
      if (!Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1]) || !Number.isFinite(halfSize[0]) || !Number.isFinite(halfSize[1])) continue;
      minU = Math.min(minU, anchor[0] - halfSize[0]);
      minV = Math.min(minV, anchor[1] - halfSize[1]);
      maxU = Math.max(maxU, anchor[0] + halfSize[0]);
      maxV = Math.max(maxV, anchor[1] + halfSize[1]);
    }
    if (!(minU <= maxU) || !(minV <= maxV)) return undefined;
    const padding = Math.max(0.0, paddingUV);
    return { minU: minU - padding, minV: minV - padding, maxU: maxU + padding, maxV: maxV + padding };
  },
} as const;

/** Swift's `rounded()`: half away from zero, where `Math.round` rounds half up. */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Spreadsheet-style column letters: A to Z, then AA. */
function columnLetters(column: number): string {
  let remaining = Math.max(0, column);
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
}
