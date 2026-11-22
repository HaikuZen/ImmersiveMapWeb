// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../math/matrix.ts";

const corners = new Float64Array(16);

/**
 * Whether a chunk of a layer can reach the view on the flat map, where a
 * chunk lies on the plane under one matrix, the Swift `LayerChunkCulling`.
 * The four corners of its box go to clip space, and the chunk is left out
 * when all four are beyond one edge of the view, or behind the camera. Never
 * leaves out a chunk that shows: the test is the box's, not the shapes', and
 * the edges are moved out by what a line or a point adds round its position
 * on screen.
 */
export const LayerChunkCulling = {
  /** The pixels a disc's edge adds round its extent, and one more for the rounding of the matrices. */
  edgeSlackPx: 2,

  /**
   * `clipFromLocal` is the matrix a vertex of the chunk is drawn under
   * (column-major), the camera's by the chunk's own. `reachPx` is how far
   * past its position a shape of the chunk reaches on screen, in pixels.
   */
  isVisible(boundsMinimum: readonly [number, number], boundsMaximum: readonly [number, number], clipFromLocal: Mat4, reachPx: number, viewportWidth: number, viewportHeight: number): boolean {
    // A chunk no position was added to: nothing to leave out.
    if (!(boundsMinimum[0] <= boundsMaximum[0]) || !(boundsMinimum[1] <= boundsMaximum[1])) return true;
    if (viewportWidth <= 0 || viewportHeight <= 0) return true;
    const marginX = 1 + ((reachPx + LayerChunkCulling.edgeSlackPx) * 2) / viewportWidth;
    const marginY = 1 + ((reachPx + LayerChunkCulling.edgeSlackPx) * 2) / viewportHeight;
    const m = clipFromLocal;
    const xs = [boundsMinimum[0], boundsMaximum[0], boundsMinimum[0], boundsMaximum[0]];
    const ys = [boundsMinimum[1], boundsMinimum[1], boundsMaximum[1], boundsMaximum[1]];
    for (let c = 0; c < 4; c++) {
      const x = xs[c]!;
      const y = ys[c]!;
      corners[c * 4] = m[0]! * x + m[4]! * y + m[12]!;
      corners[c * 4 + 1] = m[1]! * x + m[5]! * y + m[13]!;
      corners[c * 4 + 3] = m[3]! * x + m[7]! * y + m[15]!;
    }
    // Each test is linear in clip space, so four corners on its far side
    // put the whole box there. The depth is not tested: a layer draws at one
    // depth of its own, whatever the camera's far plane.
    const allOutside = (test: (x: number, y: number, w: number) => boolean): boolean => {
      for (let c = 0; c < 4; c++) if (!test(corners[c * 4]!, corners[c * 4 + 1]!, corners[c * 4 + 3]!)) return false;
      return true;
    };
    return !(
      allOutside((x, _y, w) => x + marginX * w < 0) ||
      allOutside((x, _y, w) => -x + marginX * w < 0) ||
      allOutside((_x, y, w) => y + marginY * w < 0) ||
      allOutside((_x, y, w) => -y + marginY * w < 0) ||
      allOutside((_x, _y, w) => w <= 0)
    );
  },
} as const;
