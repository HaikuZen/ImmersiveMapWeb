// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { mat4Identity, mat4Multiply, Matrix } from "../../math/matrix.ts";
import { quatAct, quatDot, quatToMat4 } from "../../math/quaternion.ts";
import { SceneModelAnimationMath } from "./scene-model-animation-math.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

describe("SceneModelAnimationMath", () => {
  test("the orientation is Rz(-heading) * Rx(pitch) * Ry(roll)", () => {
    const [heading, pitch, roll] = [30, 20, -15];
    const radians = Math.PI / 180;
    const expected = mat4Multiply(
      mat4Identity(),
      mat4Multiply(mat4Identity(), Matrix.rotationMatrixZ(mat4Identity(), -heading * radians), Matrix.rotationMatrixX(mat4Identity(), pitch * radians)),
      Matrix.rotationMatrixY(mat4Identity(), roll * radians),
    );
    const actual = quatToMat4(mat4Identity(), SceneModelAnimationMath.orientationQuaternion(heading, pitch, roll));
    for (let index = 0; index < 16; index++) expectClose(actual[index]!, expected[index]!, 1e-12);
  });

  test("heading 90 turns the forward axis (+Y, north) to east", () => {
    const forward = quatAct(SceneModelAnimationMath.orientationQuaternion(90, 0, 0), [0, 1, 0]);
    expectClose(forward[0], 1, 1e-12);
    expectClose(forward[1], 0, 1e-12);
  });

  test("the angles round-trip through the quaternion", () => {
    for (const [heading, pitch, roll] of [
      [0, 0, 0],
      [45, 10, 5],
      [-120, -30, 60],
      [170, 80, -100],
    ] as const) {
      const angles = SceneModelAnimationMath.orientationAngles(SceneModelAnimationMath.orientationQuaternion(heading, pitch, roll));
      expectClose(angles.headingDegrees, heading, 1e-9);
      expectClose(angles.pitchDegrees, pitch, 1e-9);
      expectClose(angles.rollDegrees, roll, 1e-9);
    }
  });

  test("at gimbal lock the whole turn is reported as heading", () => {
    const orientation = SceneModelAnimationMath.orientationQuaternion(40, 90, 0);
    const angles = SceneModelAnimationMath.orientationAngles(orientation);
    expectClose(angles.pitchDegrees, 90, 1e-6);
    expectClose(angles.rollDegrees, 0, 1e-12);
    const rebuilt = SceneModelAnimationMath.orientationQuaternion(angles.headingDegrees, angles.pitchDegrees, angles.rollDegrees);
    expectClose(Math.abs(quatDot(rebuilt, orientation)), 1, 1e-6);
  });

  test("the move duration is zero for no move and saturates for long ones", () => {
    const here = { latitude: 10, longitude: 20 };
    expect(SceneModelAnimationMath.positionAnimationDuration(here, here)).toBe(0);
    expect(SceneModelAnimationMath.positionAnimationDuration(here, { latitude: 11, longitude: 20 })).toBeCloseTo(SceneModelAnimationMath.maximumPositionDuration, 12);
    const short = SceneModelAnimationMath.positionAnimationDuration(here, { latitude: 10.0001, longitude: 20 });
    expect(short).toBeGreaterThan(SceneModelAnimationMath.minimumPositionDuration);
    expect(short).toBeLessThan(SceneModelAnimationMath.maximumPositionDuration);
  });

  test("the orientation interpolation clamps its progress", () => {
    const start = SceneModelAnimationMath.orientationQuaternion(0, 0, 0);
    const target = SceneModelAnimationMath.orientationQuaternion(90, 0, 0);
    expect(SceneModelAnimationMath.orientation(start, target, -1)).toBe(start);
    expect(SceneModelAnimationMath.orientation(start, target, 2)).toBe(target);
    expectClose(SceneModelAnimationMath.scalar(2, 4, 0.25), 2.5, 1e-12);
  });
});
