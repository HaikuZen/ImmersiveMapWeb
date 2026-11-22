// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `SceneModelPickMathTests`: the picking ray must be
// the exact inverse of the projection the scene model vertex shader runs, and
// the box test must be oriented, not spherical: a model is tappable where it
// is drawn and nowhere else.

import { describe, expect, test } from "vitest";
import { type Mat4, Matrix, mat4Identity, mat4Multiply, mat4TransformVec4 } from "../../math/matrix.ts";
import { mat4Invert } from "../../math/mat4-invert.ts";
import { length3, sub3, type Vec2, type Vec3 } from "../../math/vec.ts";
import { type SceneModelPickRay, SceneModelPickMath } from "./scene-model-pick-math.ts";

/** A perspective camera assembled as `RenderCamera` does, with the pixel convention of `GeoScreenProjectionMath` (origin bottom left, y up). */
function makePickCamera() {
  const drawWidth = 800;
  const drawHeight = 600;
  const eye: Vec3 = [0, 0, 10];
  const projection = Matrix.perspectiveMatrix(mat4Identity(), Math.PI / 4, drawWidth / drawHeight, 0.01, 200);
  const projectionView = mat4Multiply(mat4Identity(), projection, Matrix.lookAt(mat4Identity(), eye, [0, 0, 0], [0, 1, 0]));
  return {
    drawWidth,
    drawHeight,
    eye,
    projectionView,
    center: [drawWidth * 0.5, drawHeight * 0.5] as Vec2,
    makeRay(point: Vec2): SceneModelPickRay | null {
      return SceneModelPickMath.makeRay(point[0], point[1], drawWidth, drawHeight, projectionView, eye);
    },
    screenPoint(world: Vec3): Vec2 {
      const clip = mat4TransformVec4(projectionView, [world[0], world[1], world[2], 1]);
      return [((clip[0] / clip[3]) * 0.5 + 0.5) * drawWidth, ((clip[1] / clip[3]) * 0.5 + 0.5) * drawHeight];
    },
  };
}

const camera = makePickCamera();
const unitBoxMin: Vec3 = [-1, -1, -1];
const unitBoxMax: Vec3 = [1, 1, 1];

function inverse(matrix: Mat4): Mat4 {
  const out = mat4Identity();
  expect(mat4Invert(out, matrix)).toBe(true);
  return out;
}

function contains(rect: { minX: number; minY: number; maxX: number; maxY: number }, point: Vec2): boolean {
  return point[0] >= rect.minX && point[0] < rect.maxX && point[1] >= rect.minY && point[1] < rect.maxY;
}

describe("SceneModelPickMath", () => {
  // Ray

  test("a ray through the screen center hits the box at its near face", () => {
    const ray = camera.makeRay(camera.center)!;
    // Camera at z = 10 looking down -Z: the near face of a unit box at the origin is 9 units away.
    expect(SceneModelPickMath.intersectionDistance(ray, unitBoxMin, unitBoxMax, mat4Identity())).toBeCloseTo(9, 3);
  });

  test("a ray through a viewport corner misses a centered box", () => {
    const ray = camera.makeRay([10, 10])!;
    expect(SceneModelPickMath.intersectionDistance(ray, unitBoxMin, unitBoxMax, mat4Identity())).toBeNull();
  });

  test("the hit distance matches the projected world point", () => {
    const target: Vec3 = [0.5, -0.25, 1];
    const ray = camera.makeRay(camera.screenPoint(target))!;
    const distance = SceneModelPickMath.intersectionDistance(ray, unitBoxMin, unitBoxMax, mat4Identity())!;
    expect(Math.abs(distance - length3(sub3(target, camera.eye)))).toBeLessThan(1e-2);
  });

  test("a degenerate draw size or projection gives no ray", () => {
    expect(SceneModelPickMath.makeRay(1, 1, 0, 600, camera.projectionView, camera.eye)).toBeNull();
    expect(SceneModelPickMath.makeRay(1, 1, 800, 600, new Float64Array(16), camera.eye)).toBeNull();
  });

  // Oriented box

  test("an elongated model is tested as an oriented box rather than a sphere", () => {
    const rodMin: Vec3 = [-5, -0.05, -0.05];
    const rodMax: Vec3 = [5, 0.05, 0.05];
    const alongTheRodAxis: Vec3 = [0, 3, 0];
    const ray = camera.makeRay(camera.screenPoint(alongTheRodAxis))!;
    // The aimed point is inside the rod's bounding sphere (radius 5).
    expect(length3(alongTheRodAxis)).toBeLessThan(5);
    expect(SceneModelPickMath.intersectionDistance(ray, rodMin, rodMax, mat4Identity())).toBeNull();
    const turned = Matrix.rotationMatrixZ(mat4Identity(), Math.PI / 2);
    expect(SceneModelPickMath.intersectionDistance(ray, rodMin, rodMax, inverse(turned))).not.toBeNull();
  });

  test("a box behind the camera is not hit", () => {
    const ray = camera.makeRay(camera.center)!;
    const behind = Matrix.translationMatrix(mat4Identity(), 0, 0, 30);
    expect(SceneModelPickMath.intersectionDistance(ray, unitBoxMin, unitBoxMax, inverse(behind))).toBeNull();
  });

  test("a non-finite inverse model matrix is not hit", () => {
    // What a model scaled to nothing inverts to where an inverse is forced.
    const ray = camera.makeRay(camera.center)!;
    const collapsed = new Float64Array(16).fill(Number.POSITIVE_INFINITY);
    expect(SceneModelPickMath.intersectionDistance(ray, unitBoxMin, unitBoxMax, collapsed)).toBeNull();
    expect(mat4Invert(mat4Identity(), Matrix.scaleMatrix(mat4Identity(), 0, 0, 0))).toBe(false);
  });

  test("a camera inside the box hits at distance zero", () => {
    const ray = camera.makeRay(camera.center)!;
    expect(SceneModelPickMath.intersectionDistance(ray, [-20, -20, -20], [20, 20, 20], mat4Identity())).toBe(0);
  });

  // Screen bounds

  test("the screen bounds surround the projected box", () => {
    const bounds = SceneModelPickMath.screenBounds(unitBoxMin, unitBoxMax, mat4Identity(), camera.projectionView, camera.drawWidth, camera.drawHeight)!;
    expect(contains(bounds, camera.center)).toBe(true);
    // A corner can sit on the far edges, so the corners are tested with the edges included.
    for (const corner of [
      [-1, -1, 1],
      [1, 1, 1],
      [-1, 1, -1],
    ] as const) {
      const point = camera.screenPoint(corner);
      expect(point[0] >= bounds.minX - 1e-9 && point[0] <= bounds.maxX + 1e-9 && point[1] >= bounds.minY - 1e-9 && point[1] <= bounds.maxY + 1e-9).toBe(true);
    }
  });

  test("the screen bounds reject a box spanning the camera", () => {
    const around = Matrix.scaleMatrix(mat4Identity(), 20, 20, 20);
    expect(SceneModelPickMath.screenBounds(unitBoxMin, unitBoxMax, around, camera.projectionView, camera.drawWidth, camera.drawHeight)).toBeNull();
  });

  test("the camera distance is to the box center", () => {
    const moved = Matrix.translationMatrix(mat4Identity(), 0, 0, -5);
    expect(SceneModelPickMath.distanceFromCamera(unitBoxMin, unitBoxMax, moved, camera.eye)).toBeCloseTo(15, 12);
  });
});
