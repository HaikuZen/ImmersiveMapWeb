// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { mat4Invert } from "./mat4-invert.ts";
import { Matrix, mat4Identity, mat4Multiply } from "./matrix.ts";

test("a matrix times its inverse is the identity", () => {
  const m = Matrix.perspectiveMatrix(mat4Identity(), Math.PI / 4, 1.5, 0.01, 100);
  const t = Matrix.translationMatrix(mat4Identity(), 3, -2, 7);
  const pv = mat4Multiply(mat4Identity(), m, t);
  const inverse = mat4Identity();
  expect(mat4Invert(inverse, pv)).toBe(true);
  const product = mat4Multiply(mat4Identity(), pv, inverse);
  const identity = mat4Identity();
  for (let i = 0; i < 16; i++) expect(product[i]).toBeCloseTo(identity[i]!, 9);
  expect(mat4Invert(inverse, new Float64Array(16))).toBe(false);
});
