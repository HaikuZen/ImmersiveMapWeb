// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { LayerChunkCulling } from "./layer-chunk-culling.ts";

const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function isVisible(minimum: [number, number], maximum: [number, number], matrix: Float64Array = identity, reachPx = 0): boolean {
  return LayerChunkCulling.isVisible(minimum, maximum, matrix, reachPx, 1000, 1000);
}

describe("LayerChunkCulling", () => {
  // Under the identity matrix the view is the square from -1 to 1.
  test("a box inside or across the view is drawn", () => {
    expect(isVisible([-0.5, -0.5], [0.5, 0.5])).toBe(true);
    expect(isVisible([0.9, 0.9], [3, 3])).toBe(true);
    // Round the whole view, every corner outside it.
    expect(isVisible([-5, -5], [5, 5])).toBe(true);
  });

  test("a box beyond one edge is left out", () => {
    expect(isVisible([1.5, -0.5], [2, 0.5])).toBe(false);
    expect(isVisible([-2, -0.5], [-1.5, 0.5])).toBe(false);
    expect(isVisible([-0.5, 1.5], [0.5, 2])).toBe(false);
    expect(isVisible([-0.5, -2], [0.5, -1.5])).toBe(false);
  });

  // A line 100 pixels wide reaches 50 pixels past its position, a tenth of the view's half width here.
  test("a shape's reach on screen keeps its chunk", () => {
    expect(isVisible([1.05, -0.5], [1.2, 0.5])).toBe(false);
    expect(isVisible([1.05, -0.5], [1.2, 0.5], identity, 50)).toBe(true);
  });

  test("a box behind the camera is left out", () => {
    const behind = new Float64Array(identity);
    behind[15] = -1;
    expect(isVisible([-0.5, -0.5], [0.5, 0.5], behind)).toBe(false);
  });

  // A chunk with no position has no box to test, and is not left out.
  test("an empty box is drawn", () => {
    expect(isVisible([Infinity, Infinity], [-Infinity, -Infinity])).toBe(true);
  });
});
