// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `PinCollisionMathTests`.

import { describe, expect, test } from "vitest";
import {
  badgeContentAlpha,
  displacedCircleScale,
  displacedMorph,
  displacedMorphEndPx,
  flowerPetalOffset,
  flowerRingRadius,
  requiredScale,
  scaleCap,
  smoothingFactor,
  stableUnitDirection,
} from "./pin-collision-math.ts";

describe("PinCollisionMath", () => {
  test("the smoothing factor is zero without elapsed time", () => {
    expect(smoothingFactor(0.5, 0)).toBe(0);
  });

  test("the smoothing factor is frame rate independent", () => {
    // One 1/30 step covers the same fraction of the path as two 1/60 steps.
    const single = smoothingFactor(0.35, 1 / 30);
    const half = smoothingFactor(0.35, 1 / 60);
    expect(single).toBeCloseTo(1 - (1 - half) * (1 - half), 4);
  });

  test("the stable unit direction is a deterministic unit vector independent of the order", () => {
    const direction = stableUnitDirection(7, 42);
    expect(Math.hypot(direction[0], direction[1])).toBeCloseTo(1, 4);
    expect(stableUnitDirection(42, 7)).toEqual(direction);
    expect(stableUnitDirection(7, 42)).toEqual(direction);
  });

  test("the 64 bit hash matches FNV-1a on whole 64 bit ids", () => {
    // The reference computed with BigInt, for ids past 2^32.
    const reference = (a: bigint, b: bigint): number => {
      let hash = 0xcbf29ce484222325n;
      for (const id of a < b ? [a, b] : [b, a]) {
        let value = id;
        for (let i = 0; i < 8; i++) {
          hash ^= value & 0xffn;
          hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
          value >>= 8n;
        }
      }
      return Number(hash % 6283n) * 0.001;
    };
    for (const [a, b] of [
      [7, 42],
      [2 ** 40 + 12345, 3],
      [Number.MAX_SAFE_INTEGER, 2 ** 33],
      [0, 0],
    ] as const) {
      const angle = reference(BigInt(a), BigInt(b));
      expect(stableUnitDirection(a, b)).toEqual([Math.cos(angle), Math.sin(angle)]);
    }
  });

  test("the required scale is forced only by lack of space", () => {
    // The distance is enough for full bodies: no compression needed.
    expect(requiredScale(120, 50, 50, 8, false)).toBe(1);
    // No room: the pair splits the shortfall evenly.
    expect(requiredScale(66, 50, 50, 8, false)).toBeCloseTo(0.5, 4);
    // The neighbor is incompressible: the whole shortfall falls on the current one.
    expect(requiredScale(91, 50, 50, 8, true)).toBeCloseTo(0.5, 4);
  });

  test("the scale cap keeps displaced circles smaller than pins", () => {
    expect(scaleCap(0)).toBe(1);
    expect(scaleCap(1)).toBeCloseTo(displacedCircleScale, 4);
    const partial = scaleCap(0.5);
    expect(partial).toBeGreaterThan(displacedCircleScale);
    expect(partial).toBeLessThan(1);
  });

  test("the flower layout packs touching petals around the center", () => {
    // Adjacent petals touch: the center distance equals twice the body radius.
    const petalRadius = 30;
    const count = 5;
    const ring = flowerRingRadius(petalRadius, count);
    for (let index = 0; index < count; index++) {
      const current = flowerPetalOffset(index, count, ring);
      const next = flowerPetalOffset((index + 1) % count, count, ring);
      expect(Math.abs(Math.hypot(current[0], current[1]) - ring)).toBeLessThan(0.001);
      expect(Math.abs(Math.hypot(current[0] - next[0], current[1] - next[1]) - petalRadius * 2)).toBeLessThan(0.01);
    }
    // A pair of petals stands side by side.
    expect(flowerRingRadius(petalRadius, 2)).toBeCloseTo(petalRadius, 3);
    expect(flowerRingRadius(petalRadius, 1)).toBe(0);
  });

  test("the displaced morph turns a shifted pin into a circle", () => {
    expect(displacedMorph(0)).toBe(0);
    expect(displacedMorph(displacedMorphEndPx)).toBeCloseTo(1, 4);
    expect(displacedMorph(100)).toBe(1);
    const partial = displacedMorph(6);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  test("the badge alpha hides badges when compressed", () => {
    expect(badgeContentAlpha(1)).toBe(1);
    expect(badgeContentAlpha(0.55)).toBe(0);
    const partial = badgeContentAlpha(0.9);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });
});
