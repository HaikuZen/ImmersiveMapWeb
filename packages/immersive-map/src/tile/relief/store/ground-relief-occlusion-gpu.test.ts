// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { occlusionMetresPerTexel, occlusionRays, occlusionSteps } from "./ground-relief-occlusion-gpu.ts";

describe("the occlusion's rays, built on the CPU for the compute shader", () => {
  it("spans a tile's side over its texels at the tile's own latitude", () => {
    expect(occlusionMetresPerTexel(0, 0, 512)).toBeCloseTo(40_075_017 / 512, -2);
    const expected = (40_075_017 / 1024 / 512) * Math.cos((41.2 * Math.PI) / 180);
    expect(Math.abs(occlusionMetresPerTexel(10, 385, 512) - expected)).toBeLessThan(1);
    expect(occlusionMetresPerTexel(10, 385, 512)).toBe(Math.fround(occlusionMetresPerTexel(10, 385, 512)));
  });

  it("steps every texel near, then grows out to the radius", () => {
    const steps = occlusionSteps(20);
    expect(steps.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.at(-1)!).toBeLessThanOrEqual(20);
    expect(steps.at(-1)!).toBeGreaterThan(15);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
    expect(occlusionSteps(0.5)).toEqual([]);
    // The Swift sequence past the near texels: floor(distance * 1.25) once it exceeds distance + 1.
    expect(occlusionSteps(100)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 18, 22, 27, 33, 41, 51, 63, 78, 97]);
  });

  it("rounds the offsets half away from zero, direction by direction", () => {
    const four = occlusionRays(1, { radiusMetres: 2, directions: 4, resolution: 16 });
    expect(four.stepCount).toBe(2);
    const ints = new Int32Array(four.data);
    const floats = new Float32Array(four.data);
    const offsets = Array.from({ length: 8 }, (_, i) => [ints[i * 4], ints[i * 4 + 1]]);
    // East, south (a row down), west, north, one and two texels out.
    expect(offsets).toEqual([[1, 0], [2, 0], [0, 1], [0, 2], [-1, 0], [-2, 0], [0, -1], [0, -2]]);
    expect(Array.from({ length: 8 }, (_, i) => floats[i * 4 + 2])).toEqual([1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5]);
    const eight = new Int32Array(occlusionRays(1, { radiusMetres: 2, directions: 8, resolution: 16 }).data);
    // 0.7071 and 1.414 round to 1, -0.7071 and -1.414 to -1.
    expect([eight[8], eight[12]]).toEqual([1, 1]);
    expect([eight[24], eight[28]]).toEqual([-1, -1]);
  });

  it("has no steps for a radius under one texel, and one ray slot for the shader to bind", () => {
    const none = occlusionRays(30, { radiusMetres: 10, directions: 8, resolution: 16 });
    expect(none.stepCount).toBe(0);
    expect(none.data.byteLength).toBe(16);
  });
});
