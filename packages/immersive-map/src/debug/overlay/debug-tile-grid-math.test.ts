// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugTileGridMathTests`: the grid's cells, their
// stamps, the grid lines and the plate under a stamp.

import { describe, expect, test } from "vitest";
import { DebugTileGridDensity } from "../../render/debug/debug-tile-grid-density.ts";
import { DebugTileGridMath } from "./debug-tile-grid-math.ts";

describe("DebugTileGridMath", () => {
  test("cell bounds partition the tile without gap or overlap", () => {
    for (const density of DebugTileGridDensity.options) {
      let expectedNext = 0;
      for (let index = 0; index < density; index++) {
        const bounds = DebugTileGridMath.cellBounds(index, density);
        expect(bounds.lo, `density ${density} cell ${index} does not continue the previous cell`).toBe(expectedNext);
        expect(bounds.hi, `density ${density} cell ${index} is empty`).toBeGreaterThan(bounds.lo);
        expectedNext = bounds.hi + 1;
      }
      expect(expectedNext, `density ${density} does not reach the tile extent`).toBe(DebugTileGridMath.tileExtent);
    }
  });

  test("cell bounds for six round the uneven partition", () => {
    const expected = [
      [0, 682],
      [683, 1364],
      [1365, 2047],
      [2048, 2730],
      [2731, 3412],
      [3413, 4095],
    ];
    expected.forEach(([lo, hi], index) => {
      expect(DebugTileGridMath.cellBounds(index, 6)).toEqual({ lo, hi });
    });
  });

  test("the cell code counts columns from the west and rows from the north", () => {
    expect(DebugTileGridMath.cellCode(0, 0)).toBe("A1");
    expect(DebugTileGridMath.cellCode(2, 3)).toBe("C4");
    expect(DebugTileGridMath.cellCode(7, 7)).toBe("H8");
  });

  // The exact strings a screenshot carries. An agent reads these back to find
  // the geometry, so they are a contract and not a formatting detail.
  test("the cell label lines are self-sufficient", () => {
    expect(DebugTileGridMath.cellLabelLines({ x: 39615, y: 20486, z: 16 }, 2, 3, 6)).toEqual(["39615/20486/16", "C4", "x1365-2047", "y2048-2730"]);
  });

  // A substituted slot draws a coarser tile's geometry, so the stamp has to
  // name the tile the pixels actually came from as well as the slot they fill.
  test("a substituted cell names the source tile", () => {
    expect(DebugTileGridMath.cellLabelLines({ x: 39615, y: 20486, z: 16 }, 2, 3, 6, { x: 19807, y: 10243, z: 15 })).toEqual([
      "39615/20486/16",
      "C4",
      "x1365-2047",
      "y2048-2730",
      "src 19807/10243/15",
    ]);
  });

  test("an exact cell does not repeat its own tile as a source", () => {
    const tile = { x: 39615, y: 20486, z: 16 };
    expect(DebugTileGridMath.cellLabelLines(tile, 2, 3, 6, { ...tile })).toHaveLength(4);
  });

  test("the cell label bounds match the cell code", () => {
    for (const density of DebugTileGridDensity.options) {
      for (let row = 0; row < density; row++) {
        for (let column = 0; column < density; column++) {
          const lines = DebugTileGridMath.cellLabelLines({ x: 1, y: 2, z: 3 }, column, row, density);
          const xBounds = DebugTileGridMath.cellBounds(column, density);
          const yBounds = DebugTileGridMath.cellBounds(row, density);
          expect(lines[1]).toBe(DebugTileGridMath.cellCode(column, row));
          expect(lines[2]).toBe(`x${xBounds.lo}-${xBounds.hi}`);
          expect(lines[3]).toBe(`y${yBounds.lo}-${yBounds.hi}`);
        }
      }
    }
  });

  // The row index and `uv.y` both count from the north edge (the same axis
  // the raw MVT bytes use), so the first row sits at the top of the tile in
  // UV and a stamped y range can be pasted into a tile decoder unchanged.
  test("the cell UV rect maps rows straight into tile UV", () => {
    const topBand = DebugTileGridMath.cellUVRect(0, 0, 4);
    expect(topBand.minU).toBeCloseTo(0.0, 6);
    expect(topBand.maxU).toBeCloseTo(0.25, 6);
    expect(topBand.minV).toBeCloseTo(0.0, 6);
    expect(topBand.maxV).toBeCloseTo(0.25, 6);

    const bottomBand = DebugTileGridMath.cellUVRect(3, 3, 4);
    expect(bottomBand.minU).toBeCloseTo(0.75, 6);
    expect(bottomBand.maxU).toBeCloseTo(1.0, 6);
    expect(bottomBand.minV).toBeCloseTo(0.75, 6);
    expect(bottomBand.maxV).toBeCloseTo(1.0, 6);
  });

  test("the grid segments cover every line and stay inside the tile", () => {
    const segmentsPerLine = 8;
    const density = 6;
    const segments = DebugTileGridMath.makeGridSegments(density, segmentsPerLine);
    expect(segments).toHaveLength((density + 1) * 2 * segmentsPerLine);
    for (const segment of segments) {
      for (const point of [segment.start, segment.end]) {
        expect(point[0]).toBeGreaterThanOrEqual(0.0);
        expect(point[0]).toBeLessThanOrEqual(1.0);
        expect(point[1]).toBeGreaterThanOrEqual(0.0);
        expect(point[1]).toBeLessThanOrEqual(1.0);
      }
    }
  });

  test("only the outermost grid lines are borders", () => {
    const density = 4;
    const segments = DebugTileGridMath.makeGridSegments(density, 1);
    const borders = segments.filter((segment) => segment.isBorder);
    const borderPositions = new Set(borders.flatMap((segment) => [segment.start[0], segment.start[1]]));
    expect(borderPositions).toEqual(new Set([0.0, 1.0]));
    expect(borders).toHaveLength(2 * 2);
    expect(segments.filter((segment) => !segment.isBorder)).toHaveLength((density - 1) * 2);
  });

  // The plate covers the widest line and the full stack, and nothing beyond
  // it plus the padding: it is there to stop map labels muddying the stamp,
  // not to black out the cell.
  test("the stamp plate covers every line and only the padding", () => {
    const plate = DebugTileGridMath.makeStampPlate(
      [
        [0.5, 0.4],
        [0.5, 0.5],
        [0.5, 0.6],
      ],
      [
        [0.08, 0.01],
        [0.02, 0.02],
        [0.06, 0.01],
      ],
      0.01,
    );
    expect(plate?.minU ?? 0).toBeCloseTo(0.41, 5);
    expect(plate?.maxU ?? 0).toBeCloseTo(0.59, 5);
    expect(plate?.minV ?? 0).toBeCloseTo(0.38, 5);
    expect(plate?.maxV ?? 0).toBeCloseTo(0.62, 5);
  });

  test("the stamp plate is undefined without lines", () => {
    expect(DebugTileGridMath.makeStampPlate([], [], 0.01)).toBeUndefined();
  });

  test("the stamp plate is undefined when the line counts disagree", () => {
    expect(DebugTileGridMath.makeStampPlate([[0.5, 0.5]], [], 0.01)).toBeUndefined();
  });

  test("the stamp plate ignores non-finite lines", () => {
    const plate = DebugTileGridMath.makeStampPlate(
      [
        [0.5, 0.5],
        [Number.NaN, 0.5],
      ],
      [
        [0.1, 0.02],
        [0.1, 0.02],
      ],
      0,
    );
    expect(plate?.minU ?? 0).toBeCloseTo(0.4, 5);
    expect(plate?.maxU ?? 0).toBeCloseTo(0.6, 5);
  });

  test("the density clamp snaps to the nearest offered value", () => {
    expect(DebugTileGridDensity.clamp(6)).toBe(6);
    expect(DebugTileGridDensity.clamp(0)).toBe(2);
    expect(DebugTileGridDensity.clamp(-4)).toBe(2);
    expect(DebugTileGridDensity.clamp(5)).toBe(4);
    expect(DebugTileGridDensity.clamp(7)).toBe(6);
    expect(DebugTileGridDensity.clamp(64)).toBe(8);
  });
});
