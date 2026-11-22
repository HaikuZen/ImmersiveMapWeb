// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type ModelTileCullModel, runTriangleCount, sampleGrid, spanHoldsSample, visibleModelRuns } from "./model-tile-culling.ts";
import { cullModels } from "./model-tile-mesh.ts";
import { cullKey, keysEqual } from "./model-tile-triangle-culler.ts";

/**
 * A camera looking straight down at the tile's box: clip x and y run -1 to
 * 1 across the box, so a drawable of `4096 / u` pixels shows `u` tile units
 * a pixel (Y down on the screen).
 */
function storedToClip(): Float64Array {
  return Float64Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, 0, -1, -1, 0.25, 1]);
}

const box = (min: [number, number, number], max: [number, number, number], firstIndex: number, indexCount: number): ModelTileCullModel => ({ firstIndex, indexCount, boundsMinimum: min, boundsMaximum: max });
const tileMin: [number, number, number] = [0, 0, 0];
const tileMax: [number, number, number] = [4096, 4096, 100];

describe("spanHoldsSample", () => {
  it("finds the pixel centres a span holds", () => {
    const one = sampleGrid(1);
    expect(spanHoldsSample(0.6, 1.4, one)).toBe(false);
    expect(spanHoldsSample(0.4, 0.6, one)).toBe(true);
    expect(spanHoldsSample(1.5, 1.5, one)).toBe(true);
    expect(spanHoldsSample(-0.6, -0.4, one)).toBe(true);
  });

  it("finds the samples of the 4x pattern a quarter of a pixel apart", () => {
    const four = sampleGrid(4);
    expect(spanHoldsSample(0.6, 0.7, four)).toBe(true);
    expect(spanHoldsSample(0.4, 0.6, four)).toBe(false);
    expect(spanHoldsSample(0.13, 0.36, four)).toBe(false);
    expect(spanHoldsSample(0.1, 0.13, four)).toBe(true);
  });
});

describe("visibleModelRuns", () => {
  const matrix = storedToClip();
  // 100 tile units a pixel.
  const size = 4096 / 100;

  it("keeps the models in view, merging neighbours into one run", () => {
    const models = [box([100, 100, 0], [1000, 1000, 50], 0, 30), box([1000, 1000, 0], [2000, 2000, 50], 30, 60), box([3000, 3000, 0], [4000, 4000, 50], 90, 9)];
    const runs = visibleModelRuns(models, tileMin, tileMax, matrix, size, size, sampleGrid(1));
    expect(runs).toEqual([0, 33]);
    expect(runTriangleCount(runs)).toBe(33);
  });

  it("leaves out a model outside the view and splits the runs around it", () => {
    // The left half of the tile left of the drawable.
    const shifted = matrix.slice();
    shifted[12] = -2;
    const models = [box([100, 100, 0], [500, 500, 50], 0, 3), box([2500, 100, 0], [3000, 500, 50], 3, 3), box([3500, 100, 0], [4000, 500, 50], 6, 3)];
    expect(visibleModelRuns(models, tileMin, tileMax, shifted, size, size, sampleGrid(1))).toEqual([1, 2]);
    const gap = [box([2500, 100, 0], [3000, 500, 50], 0, 3), box([100, 100, 0], [500, 500, 50], 3, 3), box([3500, 100, 0], [4000, 500, 50], 6, 3)];
    expect(visibleModelRuns(gap, tileMin, tileMax, shifted, size, size, sampleGrid(1))).toEqual([0, 1, 2, 1]);
  });

  it("keeps a model a tenth of a pixel wide over a pixel centre and leaves out one between centres", () => {
    // 10.45 to 10.55 pixels on both axes: the centre at 10.5 is inside.
    expect(visibleModelRuns([box([1045, 1045, 0], [1055, 1055, 1], 0, 3)], tileMin, tileMax, matrix, size, size, sampleGrid(1))).toEqual([0, 1]);
    // 10.6 to 10.9 pixels across: no centre within the margin, whatever its height on the screen.
    expect(visibleModelRuns([box([1060, 1045, 0], [1090, 1055, 1], 0, 3)], tileMin, tileMax, matrix, size, size, sampleGrid(1))).toEqual([]);
    // The same model on a 4x drawable covers the sample at 10.625.
    expect(visibleModelRuns([box([1060, 1045, 0], [1090, 1055, 1], 0, 3)], tileMin, tileMax, matrix, size, size, sampleGrid(4))).toEqual([0, 1]);
  });

  it("keeps a model reaching behind the eye", () => {
    // w goes negative toward the top of the box.
    const behind = matrix.slice();
    behind[11] = -2;
    expect(visibleModelRuns([box([100, 100, 0], [4000, 4000, 100], 0, 3)], tileMin, tileMax, behind, size, size, sampleGrid(1))).toEqual([0, 1]);
  });
});

describe("cullModels", () => {
  const model = (firstIndex: number, indexCount: number) => ({ id: "", firstIndex, indexCount, boundsMinimum: [0, 0, 0] as const, boundsMaximum: [1, 1, 1] as const, latitude: 0, longitude: 0, altitudeMeters: 0 });

  it("takes the models in the index buffer's order", () => {
    expect(cullModels({ indexCount: 9, models: [model(6, 3), model(0, 6)] }).map((m) => m.firstIndex)).toEqual([0, 6]);
  });

  it("takes none when a model is not whole triangles inside the buffer", () => {
    expect(cullModels({ indexCount: 9, models: [model(0, 4), model(4, 5)] })).toEqual([]);
    expect(cullModels({ indexCount: 9, models: [model(0, 12)] })).toEqual([]);
  });
});

describe("cullKey", () => {
  const job = { projectionView: new Float64Array(16).fill(1), model: new Float64Array(16).fill(2), depthBias: 0.01, runs: [0, 10] };

  it("is equal for the same camera, matrix, drawable, samples and runs", () => {
    expect(keysEqual(cullKey(job, 100, 50, sampleGrid(1)), cullKey({ ...job, runs: [0, 10] }, 100, 50, sampleGrid(1)))).toBe(true);
  });

  it("differs when any of them changes", () => {
    const key = cullKey(job, 100, 50, sampleGrid(1));
    const moved = job.projectionView.slice();
    moved[12] = 1.5;
    expect(keysEqual(key, cullKey({ ...job, projectionView: moved }, 100, 50, sampleGrid(1)))).toBe(false);
    expect(keysEqual(key, cullKey(job, 101, 50, sampleGrid(1)))).toBe(false);
    expect(keysEqual(key, cullKey(job, 100, 50, sampleGrid(4)))).toBe(false);
    expect(keysEqual(key, cullKey({ ...job, runs: [0, 5, 6, 4] }, 100, 50, sampleGrid(1)))).toBe(false);
    expect(keysEqual(key, cullKey({ ...job, depthBias: 0.02 }, 100, 50, sampleGrid(1)))).toBe(false);
  });
});
