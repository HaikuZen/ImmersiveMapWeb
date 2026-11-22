// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeSkyVisibilityMathTests`.

import { describe, expect, test } from "vitest";
import { mat4Invert } from "../math/mat4-invert.ts";
import { Matrix, mat4Multiply } from "../math/matrix.ts";
import { GlobeSkyVisibilityMath } from "./globe-sky-visibility-math.ts";

/** A plain perspective looking down -z, the view translated by `viewZ`. */
function inverseProjectionView(viewZ: number): Float64Array {
  const projection = Matrix.perspectiveMatrix(new Float64Array(16), Math.PI / 4, 1, 0.01, 200);
  const view = Matrix.translationMatrix(new Float64Array(16), 0, 0, viewZ);
  const inverse = new Float64Array(16);
  mat4Invert(inverse, mat4Multiply(new Float64Array(16), projection, view));
  return inverse;
}

describe("GlobeSkyVisibilityMath", () => {
  test("far above a small planet the corners look past it into space", () => {
    expect(GlobeSkyVisibilityMath.isSkyVisible(inverseProjectionView(-1), [0, 0, 1], 0.14)).toBe(true);
  });

  test("close over a large planet every corner ends on the surface", () => {
    expect(GlobeSkyVisibilityMath.isSkyVisible(inverseProjectionView(-0.6), [0, 0, 0.6], 9)).toBe(false);
  });

  test("a planet behind the eye is all sky", () => {
    expect(GlobeSkyVisibilityMath.isSkyVisible(inverseProjectionView(5), [0, 0, -5], 0.5)).toBe(true);
  });
});
