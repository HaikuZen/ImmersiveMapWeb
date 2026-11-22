// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `SceneModelSelectionSnapshotTests`: the frame snapshot
// picks the model nearest the camera, reports where that model was drawn,
// and grows only the models too small to aim at.

import { describe, expect, test } from "vitest";
import { type Mat4, Matrix, mat4Identity, mat4Multiply } from "../../math/matrix.ts";
import type { Vec3 } from "../../math/vec.ts";
import { SceneModelPickMath } from "./scene-model-pick-math.ts";
import { type SceneModelSelectionEntry, SceneModelSelectionSnapshot } from "./scene-model-selection-snapshot.ts";

const drawWidth = 800;
const drawHeight = 600;
const eye: Vec3 = [0, 0, 10];
const projectionView = mat4Multiply(
  mat4Identity(),
  Matrix.perspectiveMatrix(mat4Identity(), Math.PI / 4, drawWidth / drawHeight, 0.01, 200),
  Matrix.lookAt(mat4Identity(), eye, [0, 0, 0], [0, 1, 0]),
);
const center = { x: drawWidth * 0.5, y: drawHeight * 0.5 };
/** 44 pt at a contents scale of 1: the value the selection passes. */
const touchSize = SceneModelSelectionSnapshot.minimumTouchSizePoints;
const drawnCoordinate = { latitude: 48.8584, longitude: 2.2945 };
const unitBoxMin: Vec3 = [-1, -1, -1];
const unitBoxMax: Vec3 = [1, 1, 1];
const tinyBoxMin: Vec3 = [-0.005, -0.005, -0.005];
const tinyBoxMax: Vec3 = [0.005, 0.005, 0.005];

function makeSnapshot(entries: SceneModelSelectionEntry[]): SceneModelSelectionSnapshot {
  return new SceneModelSelectionSnapshot(1, drawWidth, drawHeight, projectionView, eye, entries);
}

function unitBoxEntry(id: number, modelMatrix: Mat4 = mat4Identity()): SceneModelSelectionEntry {
  return { id, coordinate: drawnCoordinate, modelMatrix, boundsMin: unitBoxMin, boundsMax: unitBoxMax };
}

function tinyBoxEntry(id: number, modelMatrix: Mat4 = mat4Identity()): SceneModelSelectionEntry {
  return { id, coordinate: drawnCoordinate, modelMatrix, boundsMin: tinyBoxMin, boundsMax: tinyBoxMax };
}

describe("SceneModelSelectionSnapshot", () => {
  test("a tap on the model returns it with the coordinate it was drawn at", () => {
    const hit = makeSnapshot([unitBoxEntry(7)]).hitTest(center.x, center.y, touchSize);
    expect(hit?.id).toBe(7);
    expect(hit?.coordinate).toEqual(drawnCoordinate);
  });

  test("a tap beside the model hits nothing", () => {
    expect(makeSnapshot([unitBoxEntry(7)]).hitTest(10, 10, touchSize)).toBeNull();
  });

  test("the empty snapshot hits nothing", () => {
    expect(SceneModelSelectionSnapshot.empty.hitTest(center.x, center.y, touchSize)).toBeNull();
  });

  test("overlapping models resolve to the nearest one", () => {
    const snapshot = makeSnapshot([unitBoxEntry(1, Matrix.translationMatrix(mat4Identity(), 0, 0, -5)), unitBoxEntry(2)]);
    expect(snapshot.hitTest(center.x, center.y, touchSize)?.id).toBe(2);
  });

  test("a model behind the camera hits nothing", () => {
    const snapshot = makeSnapshot([unitBoxEntry(1, Matrix.translationMatrix(mat4Identity(), 0, 0, 30))]);
    expect(snapshot.hitTest(center.x, center.y, touchSize)).toBeNull();
  });

  test("a collapsed model hits nothing", () => {
    const snapshot = makeSnapshot([unitBoxEntry(1, Matrix.scaleMatrix(mat4Identity(), 0, 0, 0))]);
    expect(snapshot.hitTest(center.x, center.y, 0)).toBeNull();
  });

  // Touch target

  test("a subpixel model grows to a touch target", () => {
    const snapshot = makeSnapshot([tinyBoxEntry(3)]);
    const projected = SceneModelPickMath.screenBounds(tinyBoxMin, tinyBoxMax, mat4Identity(), projectionView, drawWidth, drawHeight)!;
    // The model must be too small to aim at for this test to mean anything.
    expect(projected.maxX - projected.minX).toBeLessThan(2);
    expect(snapshot.hitTest(center.x + 15, center.y, touchSize)?.id).toBe(3);
    expect(snapshot.hitTest(center.x + 30, center.y, touchSize)).toBeNull();
  });

  test("the touch target is off when the minimum size is zero", () => {
    const snapshot = makeSnapshot([tinyBoxEntry(3)]);
    expect(snapshot.hitTest(center.x + 15, center.y, 0)).toBeNull();
    expect(snapshot.hitTest(center.x, center.y, 0)?.id).toBe(3);
  });

  test("a model larger than the touch target is not grown", () => {
    const snapshot = makeSnapshot([unitBoxEntry(7)]);
    const projected = SceneModelPickMath.screenBounds(unitBoxMin, unitBoxMax, mat4Identity(), projectionView, drawWidth, drawHeight)!;
    expect(projected.maxX - projected.minX).toBeGreaterThan(touchSize);
    expect(snapshot.hitTest(projected.maxX + 10, center.y, touchSize)).toBeNull();
  });

  test("a geometry hit wins over a nearby touch target", () => {
    const snapshot = makeSnapshot([unitBoxEntry(7), tinyBoxEntry(3, Matrix.translationMatrix(mat4Identity(), 0.1, 0, 2))]);
    expect(snapshot.hitTest(center.x, center.y, touchSize)?.id).toBe(7);
  });
});
