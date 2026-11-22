// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { Matrix, mat4Identity, mat4Multiply, mat4TransformVec4 } from "./matrix.ts";
import { type Quat, QUAT_IDENTITY, quatAct, quatDot, quatFromAngleAxis, quatLength, quatMultiply, quatSlerp, quatToMat3, quatToMat4 } from "./quaternion.ts";
import type { Vec3 } from "./vec.ts";

function expectVector(actual: readonly number[], expected: readonly number[], accuracy = 1e-12): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expect(Math.abs(actual[index]! - expected[index]!), `component ${index}: ${actual[index]} vs ${expected[index]}`).toBeLessThanOrEqual(accuracy);
  }
}

describe("quaternion", () => {
  test("an angle-axis turn acts like the matching rotation matrix", () => {
    const angle = 0.7;
    const cases: [Vec3, (out: Float64Array, radians: number) => Float64Array][] = [
      [[1, 0, 0], Matrix.rotationMatrixX],
      [[0, 1, 0], Matrix.rotationMatrixY],
      [[0, 0, 1], Matrix.rotationMatrixZ],
    ];
    const v: Vec3 = [0.3, -1.2, 2.5];
    for (const [axis, builder] of cases) {
      const q = quatFromAngleAxis(angle, axis);
      const matrix = builder(mat4Identity(), angle);
      const expected = mat4TransformVec4(matrix, [v[0], v[1], v[2], 0]);
      expectVector(quatAct(q, v), expected.slice(0, 3));
      expectVector([...quatToMat4(mat4Identity(), q)], [...matrix]);
    }
  });

  test("the axis is normalized", () => {
    expectVector(quatFromAngleAxis(1, [0, 0, 5]), quatFromAngleAxis(1, [0, 0, 1]));
  });

  test("the product turns the right factor first, like the matrix product", () => {
    const a = quatFromAngleAxis(0.4, [0, 0, 1]);
    const b = quatFromAngleAxis(-1.1, [1, 0, 0]);
    const product = quatMultiply(a, b);
    const matrix = mat4Multiply(mat4Identity(), quatToMat4(mat4Identity(), a), quatToMat4(mat4Identity(), b));
    expectVector([...quatToMat4(mat4Identity(), product)], [...matrix]);
    const v: Vec3 = [1, 2, 3];
    expectVector(quatAct(product, v), quatAct(a, quatAct(b, v)));
    expectVector(quatMultiply(QUAT_IDENTITY, a), a);
  });

  test("the 3x3 matrix is column-major", () => {
    const q = quatFromAngleAxis(Math.PI / 2, [0, 0, 1]);
    const m = quatToMat3(q);
    // Column 0 is where +X goes: +Y.
    expectVector([m[0]!, m[1]!, m[2]!], [0, 1, 0]);
    expectVector([m[3]!, m[4]!, m[5]!], [-1, 0, 0]);
  });

  test("slerp passes through the endpoints and halves the angle", () => {
    const from = QUAT_IDENTITY;
    const to = quatFromAngleAxis(Math.PI / 2, [0, 0, 1]);
    expectVector(quatSlerp(from, to, 0), from);
    expectVector(quatSlerp(from, to, 1), to);
    expectVector(quatSlerp(from, to, 0.5), quatFromAngleAxis(Math.PI / 4, [0, 0, 1]));
    expect(quatLength(quatSlerp(from, to, 0.3))).toBeCloseTo(1, 12);
  });

  test("slerp takes the shorter arc for quaternions in opposite hemispheres", () => {
    const from = quatFromAngleAxis(0.2, [0, 1, 0]);
    const target = quatFromAngleAxis(0.6, [0, 1, 0]);
    const negated: Quat = [-target[0], -target[1], -target[2], -target[3]];
    const middle = quatSlerp(from, negated, 0.5);
    expect(Math.abs(quatDot(middle, quatFromAngleAxis(0.4, [0, 1, 0])))).toBeCloseTo(1, 12);
  });

  test("slerp of nearly equal rotations stays finite and normalized", () => {
    const from = quatFromAngleAxis(1e-9, [1, 0, 0]);
    const middle = quatSlerp(from, QUAT_IDENTITY, 0.5);
    for (const component of middle) expect(Number.isFinite(component)).toBe(true);
    expect(quatLength(middle)).toBeCloseTo(1, 12);
  });
});
