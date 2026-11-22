// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the CPU parts of the Swift `DebugOverlayRendererTests`: the
// outline widths, the label anchor, the watermark points and placement, and
// the grid cells' room for their stamps.

import { describe, expect, test } from "vitest";
import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import type { Vec2 } from "../../math/vec.ts";
import { DebugOverlayGeometry } from "./debug-overlay-geometry.ts";

function cellCornerPoints(minCorner: Vec2, maxCorner: Vec2): ScreenPointOutput[] {
  const corners: Vec2[] = [
    [minCorner[0], minCorner[1]],
    [maxCorner[0], minCorner[1]],
    [maxCorner[0], maxCorner[1]],
    [minCorner[0], maxCorner[1]],
  ];
  return corners.map(([x, y]) => ({ positionX: x, positionY: y, depth: 0, visible: 1, visibilityAlpha: 1 }));
}

function expectUVs(actual: readonly { uv: Vec2 }[], expected: readonly Vec2[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((input, index) => {
    expect(input.uv[0]).toBeCloseTo(expected[index]![0], 6);
    expect(input.uv[1]).toBeCloseTo(expected[index]![1], 6);
  });
}

describe("DebugOverlayGeometry", () => {
  test("a coarser zoom takes a thicker outline", () => {
    // The deepest zoom is thinnest.
    expect(DebugOverlayGeometry.tileOutlineThickness(10, 10)).toBe(4);
    expect(DebugOverlayGeometry.tileOutlineThickness(9, 10)).toBe(10);
    expect(DebugOverlayGeometry.tileOutlineThickness(7, 10)).toBe(22);
    // Capped.
    expect(DebugOverlayGeometry.tileOutlineThickness(0, 14)).toBe(40);
    // Never under the thinnest.
    expect(DebugOverlayGeometry.tileOutlineThickness(12, 10)).toBe(4);
  });

  test("the tile label stands at the mean of the tile points on screen", () => {
    // A tile with no point on screen has no label.
    expect(DebugOverlayGeometry.makeTileLabelAnchor([])).toBeUndefined();
    expect(DebugOverlayGeometry.makeTileLabelAnchor([[100, 200]])).toEqual([100, 200]);
    // The centre of a whole tile, sliding with the visible part of a cut one.
    expect(
      DebugOverlayGeometry.makeTileLabelAnchor([
        [0, 0],
        [200, 100],
        [100, 50],
      ]),
    ).toEqual([100, 50]);
  });

  test("the watermark anchors are distributed inside the tile", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkUVs(3)).toEqual([
      [0.25, 0.25],
      [0.5, 0.25],
      [0.75, 0.25],
      [0.25, 0.5],
      [0.5, 0.5],
      [0.75, 0.5],
      [0.25, 0.75],
      [0.5, 0.75],
      [0.75, 0.75],
    ]);
  });

  test("the watermark projection inputs use only local basis points", () => {
    const tile = { x: 154, y: 79, z: 8 };
    const inputs = DebugOverlayGeometry.makeTileWatermarkProjectionPointInputs([0.5, 0.5], { width: 100, height: 20 }, tile, 0.2, 0.1);
    expectUVs(inputs, [
      [0.5, 0.5],
      [0.502, 0.5],
      [0.5, 0.498],
    ]);
    expect(inputs.map((input) => input.tile)).toEqual([tile, tile, tile]);
  });

  test("the watermark projection inputs account for the padding", () => {
    const inputs = DebugOverlayGeometry.makeTileWatermarkProjectionPointInputs([0.5, 0.5], { width: 100, height: 20 }, { x: 154, y: 79, z: 8 }, 0.2, 0.1, [8, 4]);
    expectUVs(inputs, [
      [0.5, 0.5],
      [0.5017241, 0.5],
      [0.5, 0.49827588],
    ]);
  });

  test("an empty run has no watermark points", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkProjectionPointInputs([0.5, 0.5], { width: 0, height: 0 }, { x: 0, y: 0, z: 0 }, 0.2, 0.1)).toEqual([]);
  });

  test("the watermark text uses a small stroke width", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkTextStyle().strokeWidthPx).toBe(2.0);
  });

  test("a grid cell is stamped when its screen box is large enough", () => {
    expect(DebugOverlayGeometry.isCellLargeEnoughForText(cellCornerPoints([100, 100], [260, 240]), 0, 48)).toBe(true);
  });

  // The short side decides: a cell seen almost edge-on under a steep pitch is
  // wide and a few pixels tall, and its stamp would be a smear.
  test("a grid cell is skipped when its short side is too small", () => {
    expect(DebugOverlayGeometry.isCellLargeEnoughForText(cellCornerPoints([100, 100], [900, 130]), 0, 48)).toBe(false);
  });

  test("a grid cell is skipped when a corner does not project", () => {
    const corners = cellCornerPoints([100, 100], [400, 400]);
    corners[2] = { positionX: 400, positionY: 400, depth: 0, visible: 0, visibilityAlpha: 0 };
    expect(DebugOverlayGeometry.isCellLargeEnoughForText(corners, 0, 48)).toBe(false);
  });

  test("a grid cell is skipped when the index is out of range", () => {
    expect(DebugOverlayGeometry.isCellLargeEnoughForText(cellCornerPoints([100, 100], [400, 400]), 1, 48)).toBe(false);
  });

  test("the cell line heights give the code line the most room", () => {
    const fractions = DebugOverlayGeometry.cellLineHeightFractions(4);
    expect(fractions).toHaveLength(4);
    expect(Math.max(...fractions)).toBe(fractions[1]);
  });

  test("the cell line heights cover a substituted fifth line", () => {
    const fractions = DebugOverlayGeometry.cellLineHeightFractions(5);
    expect(fractions).toHaveLength(5);
    expect(fractions.slice(0, 4)).toEqual(DebugOverlayGeometry.cellLineHeightFractions(4));
    expect(fractions.reduce((sum, fraction) => sum + fraction, 0)).toBeLessThan(1.0);
  });

  test("the screen placement returns the axes of an on-screen anchor", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkScreenPlacement([500, 400], [502, 400], [500, 398], [100, 20], [1000, 800])).toEqual({
      xAxis: [2, 0],
      yAxis: [0, -2],
    });
  });

  test("the screen placement rejects blown-up projection axes", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkScreenPlacement([500, 400], [120_500, 400], [500, -95_600], [100, 20], [1000, 800])).toBeUndefined();
  });

  test("the screen placement rejects a non-finite projection", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkScreenPlacement([Number.POSITIVE_INFINITY, 400], [502, 400], [500, 398], [100, 20], [1000, 800])).toBeUndefined();
  });

  test("the screen placement rejects fully off-screen text", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkScreenPlacement([-500, 400], [-498, 400], [-500, 398], [100, 20], [1000, 800])).toBeUndefined();
  });

  test("the screen placement keeps partly visible text", () => {
    expect(DebugOverlayGeometry.makeTileWatermarkScreenPlacement([-40, 400], [-38, 400], [-40, 398], [100, 20], [1000, 800])).toBeDefined();
  });

  test("the outline pieces run round the tile", () => {
    const segments = DebugOverlayGeometry.makeTileOverlaySegments(1);
    expect(segments).toEqual([
      { start: [0, 0], end: [1, 0] },
      { start: [1, 0], end: [1, 1] },
      { start: [1, 1], end: [0, 1] },
      { start: [0, 1], end: [0, 0] },
    ]);
    expect(DebugOverlayGeometry.makeTileOverlaySegments(8)).toHaveLength(32);
  });

  test("stacked text lines centre on their anchor, the first on top", () => {
    const entries = DebugOverlayGeometry.makeTileTextEntries([100, 200], ["a", "b", "c"], 20, 10, [0, 0]);
    expect(entries.map((entry) => entry.position)).toEqual([
      [100, 210],
      [100, 200],
      [100, 190],
    ]);
  });
});
