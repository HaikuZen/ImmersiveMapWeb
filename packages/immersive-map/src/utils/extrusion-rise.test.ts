// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A port of the Swift `ExtrusionRiseTests` (the model tile's wait is the
// model archive's, stage 7).

import { describe, expect, test } from "vitest";
import { ExtrusionRise } from "./extrusion-rise.ts";

const makeRise = () => new ExtrusionRise<number>(String);

describe("ExtrusionRise", () => {
  test("the first frame stands at once", () => {
    const rise = makeRise();
    rise.advance([1, 2], 10, 0.6);
    expect(rise.heightScale(1, 10)).toBe(1);
    expect(rise.heightScale(2, 10)).toBe(1);
    expect(rise.isAnimating).toBe(false);
  });

  test("a part arriving later rises on its own", () => {
    const rise = makeRise();
    rise.advance([1], 0, 0.6);
    rise.advance([1, 2], 1, 0.6);
    expect(rise.heightScale(2, 1)).toBe(0);
    expect(rise.isAnimating).toBe(true);
    rise.advance([1, 2], 1.3, 0.6);
    expect(rise.heightScale(1, 1.3)).toBe(1);
    expect(rise.progress(2, 1.3)).toBeCloseTo(0.5, 6);
    expect(rise.heightScale(2, 1.3)).toBeCloseTo(0.875, 6);
    rise.advance([1, 2], 1.6, 0.6);
    expect(rise.heightScale(2, 1.6)).toBeCloseTo(1, 6);
    expect(rise.isAnimating).toBe(false);
  });

  test("leaving the zoom drops every part at once", () => {
    const rise = makeRise();
    rise.advance([1], 0, 0.5);
    rise.advance([], 0.1, 0.5);
    expect(rise.heightScale(1, 0.1)).toBe(0);
    expect(rise.isAnimating).toBe(false);
    rise.advance([1], 0.2, 0.5);
    expect(rise.heightScale(1, 0.2)).toBe(0);
    expect(rise.isAnimating).toBe(true);
  });

  test("zero seconds stands every part at once", () => {
    const rise = makeRise();
    rise.advance([], 0, 0);
    rise.advance([1], 0.01, 0);
    expect(rise.heightScale(1, 0.01)).toBe(1);
    expect(rise.isAnimating).toBe(false);
  });

  test("a part taking over overlapping ground keeps its height", () => {
    // Parts as [cell, size]: a coarse cell's ground holds its finer ones.
    const rise = new ExtrusionRise<[number, number]>(([cell, size]) => `${cell}/${size}`);
    const overlaps = (a: [number, number], b: [number, number]) => Math.floor(a[0] / (b[1] / a[1])) === b[0] || Math.floor(b[0] / (a[1] / b[1])) === a[0];
    rise.advance([[0, 2]], 0, 0.6);
    rise.advance([[0, 2], [5, 2]], 1, 0.6);
    rise.advance([[0, 1], [1, 1], [5, 2]], 1.1, 0.6, overlaps);
    expect(rise.heightScale([0, 1], 1.1)).toBe(1);
    expect(rise.heightScale([1, 1], 1.1)).toBe(1);
    expect(rise.heightScale([5, 2], 1.1)).toBeLessThan(1);
    rise.advance([[0, 1], [1, 1], [5, 2], [7, 2]], 1.2, 0.6, overlaps);
    expect(rise.heightScale([7, 2], 1.2)).toBe(0);
  });

  test("a reset forgets every part, and the next frame stands at once", () => {
    const rise = makeRise();
    rise.advance([1], 0, 0.6);
    rise.advance([1, 2], 1, 0.6);
    rise.reset();
    expect(rise.heightScale(1, 1)).toBe(0);
    rise.advance([2], 2, 0.6);
    expect(rise.heightScale(2, 2)).toBe(1);
  });
});
