// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Mat4, Matrix } from "./matrix.ts";

/**
 * The orthographic matrix of the drawable in pixels (origin bottom-left, y
 * up, z in [-1, 1]), rebuilt only when the drawable's size changes.
 */
export class ScreenMatrix {
  private readonly matrix: Mat4 = new Float64Array(16);
  private hasMatrix = false;
  private width = 0;
  private height = 0;

  update(width: number, height: number): void {
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      Matrix.orthographicMatrix(this.matrix, 0, width, 0, height, -1, 1);
      this.hasMatrix = true;
    }
  }

  /** The matrix, null before the first `update`. The same array every call. */
  get(): Mat4 | null {
    return this.hasMatrix ? this.matrix : null;
  }
}
