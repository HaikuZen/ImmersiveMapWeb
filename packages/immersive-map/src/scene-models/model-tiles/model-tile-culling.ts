// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Which models of a model tile a frame draws. Not in Swift, which draws a
 * whole tile in one call: a tile of the Kremlin is over a million
 * triangles, and drawn small at zoom 14 most of them cover no pixel.
 *
 * Each model of a tile is a contiguous range of the tile's index buffer
 * (the format's model table) with its own bounding box. A model is left out
 * when its box lies wholly outside one side of the view, or when the box's
 * outline on the screen holds no sample of the drawable: a model whose
 * outline holds no sample cannot cover one, so leaving it out changes no
 * pixel. This is the "smaller than a pixel" rule made exact: a model a
 * tenth of a pixel wide may still cover the one pixel centre it sits on,
 * and one nearly a pixel wide that falls between centres covers none. A
 * box a pixel wide or more always holds a sample. The models left form runs,
 * neighbours merged, which the frame draws or hands to the GPU's triangle
 * culling (`ModelTileTriangleCuller`), which applies the same rule to each
 * triangle.
 */

import type { Mat4 } from "../../math/matrix.ts";

/** A model of a tile as the frame culls it: its triangles and its box in tile space. */
export interface ModelTileCullModel {
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly boundsMinimum: readonly [number, number, number];
  readonly boundsMaximum: readonly [number, number, number];
}

/**
 * Where the drawable's samples are along each axis, in pixels: at
 * `phase + k * step`. One sample a pixel is the pixel's centre. The four
 * samples of WebGPU's 4x pattern sit at the eighths 1, 3, 5 and 7 of a
 * pixel on each axis (in pairs), so on either axis alone they are a grid a
 * quarter of a pixel apart.
 */
export interface SampleGrid {
  readonly step: number;
  readonly phase: number;
}

export function sampleGrid(sampleCount: number): SampleGrid {
  return sampleCount > 1 ? { step: 0.25, phase: 0.125 } : { step: 1, phase: 0.5 };
}

/**
 * How far an outline is widened before it is tested against the samples,
 * in pixels: the GPU snaps a vertex to a sixteenth or a 256th of a pixel
 * and evaluates the matrices in its own order, so a model or a triangle is
 * left out only when no sample lies within this of its outline.
 */
export const sampleMarginPixels = 1 / 64;

/**
 * A model's box is tested this much wider again: the CPU's matrices are
 * float64 and the GPU's float32, which moves a point by far less. Wider
 * than half a pixel, every outline would hold a sample.
 */
const modelMarginPixels = 1 / 16;

/** Whether the span from `low` to `high` holds a sample of the grid. */
export function spanHoldsSample(low: number, high: number, grid: SampleGrid): boolean {
  return Math.floor((high - grid.phase) / grid.step) >= Math.ceil((low - grid.phase) / grid.step);
}

/**
 * The runs of triangles of the tile's models a frame draws: pairs of the
 * first triangle and the triangle count, neighbours merged, in the index
 * buffer's order. `storedToClip` takes a vertex's stored position (a place
 * in the tile's box, 0 to 1 on each axis) to clip space. `toStored` takes a
 * point of tile space to the stored positions: the inverse of the tile's
 * position matrix, a scale and an offset on each axis.
 */
export function visibleModelRuns(
  models: readonly ModelTileCullModel[],
  tileBoundsMinimum: readonly [number, number, number],
  tileBoundsMaximum: readonly [number, number, number],
  storedToClip: Mat4,
  width: number,
  height: number,
  grid: SampleGrid,
): number[] {
  const runs: number[] = [];
  const corner = new Float64Array(3);
  for (const model of models) {
    if (model.indexCount < 3) continue;
    let outsideLeft = true;
    let outsideRight = true;
    let outsideBottom = true;
    let outsideTop = true;
    let outsideNear = true;
    let behind = false;
    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumY = Infinity;
    let maximumY = -Infinity;
    for (let i = 0; i < 8; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const extent = tileBoundsMaximum[axis]! - tileBoundsMinimum[axis]!;
        const value = i & (1 << axis) ? model.boundsMaximum[axis]! : model.boundsMinimum[axis]!;
        corner[axis] = extent > 0 ? (value - tileBoundsMinimum[axis]!) / extent : 0;
      }
      const m = storedToClip;
      const x = m[0]! * corner[0]! + m[4]! * corner[1]! + m[8]! * corner[2]! + m[12]!;
      const y = m[1]! * corner[0]! + m[5]! * corner[1]! + m[9]! * corner[2]! + m[13]!;
      const z = m[2]! * corner[0]! + m[6]! * corner[1]! + m[10]! * corner[2]! + m[14]!;
      const w = m[3]! * corner[0]! + m[7]! * corner[1]! + m[11]! * corner[2]! + m[15]!;
      outsideLeft &&= x < -w;
      outsideRight &&= x > w;
      outsideBottom &&= y < -w;
      outsideTop &&= y > w;
      outsideNear &&= z < 0;
      if (w <= 0) {
        behind = true;
        continue;
      }
      const px = (x / w) * 0.5 * width + 0.5 * width;
      const py = (0.5 - (y / w) * 0.5) * height;
      minimumX = Math.min(minimumX, px);
      maximumX = Math.max(maximumX, px);
      minimumY = Math.min(minimumY, py);
      maximumY = Math.max(maximumY, py);
    }
    if (outsideLeft || outsideRight || outsideBottom || outsideTop || outsideNear) continue;
    // A box reaching behind the eye has no outline on the screen: it is kept.
    if (!behind) {
      const margin = modelMarginPixels + sampleMarginPixels;
      if (!spanHoldsSample(minimumX - margin, maximumX + margin, grid) || !spanHoldsSample(minimumY - margin, maximumY + margin, grid)) continue;
    }
    const first = Math.floor(model.firstIndex / 3);
    const count = Math.floor(model.indexCount / 3);
    const last = runs.length - 2;
    if (last >= 0 && runs[last]! + runs[last + 1]! === first) runs[last + 1]! += count;
    else runs.push(first, count);
  }
  return runs;
}

/** The triangles the runs hold. */
export function runTriangleCount(runs: readonly number[]): number {
  let count = 0;
  for (let i = 1; i < runs.length; i += 2) count += runs[i]!;
  return count;
}
