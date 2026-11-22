// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `ImmersiveMapSceneModelsControllerTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapGeoPath } from "../geo/immersive-map-geo-path.ts";
import { ImmersiveMapSceneModel } from "./immersive-map-scene-model.ts";
import { ImmersiveMapSceneModelsController } from "./immersive-map-scene-models-controller.ts";

function makeModel(id: number, latitude = 10, longitude = 20): ImmersiveMapSceneModel {
  return ImmersiveMapSceneModel.make({ id, source: `models/m${id}.glb`, coordinate: { latitude, longitude } });
}

const straightPath = ImmersiveMapGeoPath.between({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 40 });

function makeAnimatableModel(): ImmersiveMapSceneModel {
  return makeModel(1, 0, 0);
}

/** Lets the queued completions run: they are delivered in microtasks. */
async function flushCompletions(): Promise<void> {
  await Promise.resolve();
}

describe("ImmersiveMapSceneModelsController", () => {
  test("a snapshot is null without changes, and consuming it is destructive", () => {
    const controller = new ImmersiveMapSceneModelsController();
    expect(controller.consumeSnapshot()).toBeNull();
    controller.add(makeModel(1));
    expect(controller.consumeSnapshot()?.models.map((model) => model.id)).toEqual([1]);
    expect(controller.consumeSnapshot()).toBeNull();
  });

  test("a removal drains into removedIds once", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeModel(1));
    controller.consumeSnapshot();
    controller.remove(1);
    const snapshot = controller.consumeSnapshot();
    expect(snapshot?.models).toHaveLength(0);
    expect(snapshot?.removedIds).toEqual([1]);
    controller.markSnapshotDirty();
    expect(controller.consumeSnapshot()?.removedIds).toEqual([]);
  });

  test("set fully replaces and reports the vanished ids", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add([makeModel(1), makeModel(2)]);
    controller.consumeSnapshot();
    controller.set([makeModel(2), makeModel(3)]);
    const snapshot = controller.consumeSnapshot();
    expect(snapshot?.models.map((model) => model.id).sort()).toEqual([2, 3]);
    expect(snapshot?.removedIds).toEqual([1]);
  });

  test("transform mutations carry their durations, the latest winning, and drain", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeModel(7));
    controller.consumeSnapshot();
    controller.setScale(7, 2.5, 0.5);
    controller.setOrientation(7, { headingDegrees: 90 }, 0.8);
    const snapshot = controller.consumeSnapshot();
    expect(snapshot?.transformAnimationDurationsById.get(7)).toBe(0.8);
    expect(snapshot?.models[0]?.scale).toBe(2.5);
    expect(snapshot?.models[0]?.headingDegrees).toBe(90);
    controller.markSnapshotDirty();
    expect(controller.consumeSnapshot()?.transformAnimationDurationsById.size).toBe(0);
  });

  test("an orientation change keeps the values left out", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(ImmersiveMapSceneModel.make({ id: 1, source: "m.glb", coordinate: { latitude: 0, longitude: 0 }, pitchDegrees: 12, rollDegrees: 4 }));
    controller.setOrientation(1, { headingDegrees: 30 });
    const model = controller.model(1)!;
    expect([model.headingDegrees, model.pitchDegrees, model.rollDegrees]).toEqual([30, 12, 4]);
    expect(controller.consumeSnapshot()?.transformAnimationDurationsById.get(1)).toBe(0.3);
  });

  test("a negative duration snaps", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeModel(1));
    controller.setAltitude(1, 30, -1);
    expect(controller.consumeSnapshot()?.transformAnimationDurationsById.get(1)).toBe(0);
  });

  test("a move updates only the coordinate", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeModel(3, 10, 20));
    controller.consumeSnapshot();
    controller.move(3, { latitude: 11, longitude: 21 });
    const snapshot = controller.consumeSnapshot();
    expect(snapshot?.models[0]?.coordinate).toEqual({ latitude: 11, longitude: 21 });
    expect(snapshot?.transformAnimationDurationsById.size).toBe(0);
  });

  test("mutations of an unknown id change nothing", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.move(9, { latitude: 1, longitude: 1 });
    controller.setScale(9, 2);
    expect(controller.consumeSnapshot()).toBeNull();
  });

  test("the version grows monotonically", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeModel(1));
    const first = controller.consumeSnapshot()?.version ?? 0;
    controller.move(1, { latitude: 12, longitude: 20 });
    controller.setAltitude(1, 50, 0);
    const second = controller.consumeSnapshot()?.version ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  test("the change handler is owner-scoped", () => {
    const controller = new ImmersiveMapSceneModelsController();
    const ownerA = {};
    const ownerB = {};
    let count = 0;
    controller.setChangeHandler(() => (count += 1), ownerA);
    controller.add(makeModel(1));
    expect(count).toBe(1);
    // A stale owner must not detach the handler another owner installed.
    controller.clearChangeHandler(ownerB);
    controller.add(makeModel(2));
    expect(count).toBe(2);
    controller.clearChangeHandler(ownerA);
    controller.add(makeModel(3));
    expect(count).toBe(2);
  });

  // Path animation completions

  test("superseding an animation completes the old one once with false", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    const calls: boolean[] = [];
    controller.animate(1, straightPath, 5, {}, (finished) => calls.push(finished));
    controller.animate(1, straightPath, 5);
    // Never from inside the call that ended the animation.
    expect(calls).toEqual([]);
    await flushCompletions();
    expect(calls).toEqual([false]);
  });

  test("animate lands the descriptor on the path's end", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    controller.animate(1, straightPath, 5, { appliesPitch: false });
    const snapshot = controller.consumeSnapshot()!;
    const model = snapshot.models[0]!;
    expect(model.coordinate.longitude).toBeCloseTo(40, 9);
    expect(model.headingDegrees).toBeCloseTo(90, 6);
    const request = snapshot.pathAnimationsById.get(1)!;
    expect(request.curve).toBe("easeOut");
    expect(request.appliesHeading).toBe(true);
    expect(request.appliesPitch).toBe(false);
  });

  test("animating a missing model or along a degenerate path completes with false", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    const calls: boolean[] = [];
    controller.animate(2, straightPath, 5, {}, (finished) => calls.push(finished));
    controller.animate(1, ImmersiveMapGeoPath.make([{ latitude: 0, longitude: 0 }]), 5, {}, (finished) => calls.push(finished));
    await flushCompletions();
    expect(calls).toEqual([false, false]);
    expect(controller.consumeSnapshot()?.pathAnimationsById.size).toBe(0);
  });

  test("cancelling before the first frame restores the descriptor", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    controller.consumeSnapshot();
    let completed: boolean | null = null;
    controller.animate(1, straightPath, 5, {}, (finished) => (completed = finished));
    controller.cancelPathAnimation(1);
    const snapshot = controller.consumeSnapshot()!;
    expect(snapshot.models[0]!.coordinate.longitude).toBeCloseTo(0, 9);
    expect(snapshot.pathAnimationsById.size).toBe(0);
    await flushCompletions();
    expect(completed).toBe(false);
  });

  test("cancelling after the renderer took the request is handed on as a cancellation", () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    controller.animate(1, straightPath, 5);
    controller.consumeSnapshot();
    controller.cancelPathAnimation(1);
    expect(controller.consumeSnapshot()?.cancelledPathAnimationIds).toEqual([1]);
  });

  test("a stale result does not complete a newer animation", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    controller.animate(1, straightPath, 5);
    const stale = controller.consumeSnapshot()!.pathAnimationsById.get(1)!;
    let newer: boolean | null = null;
    controller.animate(1, straightPath, 5, {}, (finished) => (newer = finished));
    controller.applyPathAnimationResults([
      { id: 1, generation: stale.generation, finished: true, coordinate: { latitude: 0, longitude: 20 }, altitudeMeters: 0, headingDegrees: 90, pitchDegrees: 0 },
    ]);
    await flushCompletions();
    expect(newer).toBeNull();
  });

  test("a result updates the descriptor without dirtying the snapshot", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    let completed: boolean | null = null;
    controller.animate(1, straightPath, 5, {}, (finished) => (completed = finished));
    const request = controller.consumeSnapshot()!.pathAnimationsById.get(1)!;
    controller.applyPathAnimationResults([
      { id: 1, generation: request.generation, finished: false, coordinate: { latitude: 0, longitude: 17 }, altitudeMeters: 1234, headingDegrees: 90, pitchDegrees: 0 },
    ]);
    await flushCompletions();
    expect(completed).toBe(false);
    expect(controller.consumeSnapshot()).toBeNull();
    controller.markSnapshotDirty();
    const model = controller.consumeSnapshot()!.models[0]!;
    expect(model.coordinate.longitude).toBeCloseTo(17, 9);
    expect(model.altitudeMeters).toBeCloseTo(1234, 9);
  });

  test("removing, replacing, clearing and dropping all deliver false exactly once", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add([makeModel(1, 0, 0), makeModel(2, 0, 0), makeModel(3, 0, 0), makeModel(4, 0, 0)]);
    const calls: [number, boolean][] = [];
    for (const id of [1, 2, 3, 4]) controller.animate(id, straightPath, 5, {}, (finished) => calls.push([id, finished]));
    controller.remove(1);
    controller.set([makeModel(3, 0, 0), makeModel(4, 0, 0)]);
    controller.cancelAllPathAnimations();
    controller.clear();
    await flushCompletions();
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
    ]);
  });

  test("a finished result completes with true", async () => {
    const controller = new ImmersiveMapSceneModelsController();
    controller.add(makeAnimatableModel());
    const calls: boolean[] = [];
    controller.animate(1, straightPath, 5, {}, (finished) => calls.push(finished));
    const request = controller.consumeSnapshot()!.pathAnimationsById.get(1)!;
    const result = { id: 1, generation: request.generation, finished: true, coordinate: { latitude: 0, longitude: 40 }, altitudeMeters: 0, headingDegrees: 90, pitchDegrees: 0 };
    controller.applyPathAnimationResults([result]);
    controller.applyPathAnimationResults([result]);
    await flushCompletions();
    expect(calls).toEqual([true]);
  });
});
