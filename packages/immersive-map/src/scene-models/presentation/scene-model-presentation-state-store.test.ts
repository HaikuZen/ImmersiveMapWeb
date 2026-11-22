// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `SceneModelPresentationStateStoreTests` and
// `SceneModelPathAnimationTests`. Deterministic with injected times: the
// animations are pure functions of (snapshot, apply time, query time).

import { describe, expect, test } from "vitest";
import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { GeoProjectionBasis } from "../../geo/geo-projection-basis.ts";
import { ImmersiveMapGeoPath } from "../../geo/immersive-map-geo-path.ts";
import type { ImmersiveMapPathAnimationCurve } from "../../geo/immersive-map-path-animation-curve.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { type Quat, quatAct, quatDot } from "../../math/quaternion.ts";
import { ImmersiveMapSceneModel } from "../immersive-map-scene-model.ts";
import { makeSceneModelsSnapshot, type SceneModelPathAnimationRequest, type SceneModelsSnapshot } from "../scene-model-render-source.ts";
import { SceneModelAnimationMath } from "./scene-model-animation-math.ts";
import { type PresentedSceneModel, SceneModelPresentationStateStore } from "./scene-model-presentation-state-store.ts";

interface ModelValues {
  readonly latitude?: number;
  readonly longitude?: number;
  readonly headingDegrees?: number;
  readonly scale?: number;
  readonly altitudeMeters?: number;
}

function makeModel(id: number, values: ModelValues = {}): ImmersiveMapSceneModel {
  return ImmersiveMapSceneModel.make({
    id,
    source: "models/m.glb",
    coordinate: { latitude: values.latitude ?? 0, longitude: values.longitude ?? 0 },
    altitudeMeters: values.altitudeMeters ?? 0,
    headingDegrees: values.headingDegrees ?? 0,
    scale: values.scale ?? 1,
  });
}

function makeSnapshot(
  models: ImmersiveMapSceneModel[],
  options: { durations?: [number, number][]; pathAnimations?: [number, SceneModelPathAnimationRequest][]; cancelled?: number[] } = {},
): SceneModelsSnapshot {
  return makeSceneModelsSnapshot({
    models,
    transformAnimationDurationsById: new Map(options.durations ?? []),
    pathAnimationsById: new Map(options.pathAnimations ?? []),
    cancelledPathAnimationIds: options.cancelled ?? [],
    version: 1,
  });
}

function longitudeOf(presented: PresentedSceneModel): number {
  return (ImmersiveMapProjection.longitudeFromNormalizedWorldX(presented.projectionBasis.normalizedWorldX) * 180) / Math.PI;
}

function latitudeOf(presented: PresentedSceneModel): number {
  return (Math.asin(Math.min(Math.max(presented.projectionBasis.sphereUnit[1], -1), 1)) * 180) / Math.PI;
}

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

describe("SceneModelPresentationStateStore", () => {
  test("a fresh model presents at its target without animations", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1, { latitude: 5, longitude: 6 })]), 0);
    const presented = store.presentedEntries(0);
    expect(presented).toHaveLength(1);
    expect(presented[0]!.projectionBasis).toEqual(GeoProjectionBasis.fromCoordinate({ latitude: 5, longitude: 6 }));
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("still models return the cached list", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(2), makeModel(1)]), 0);
    const first = store.presentedEntries(1);
    expect(first.map((entry) => entry.id)).toEqual([1, 2]);
    expect(store.presentedEntries(2)).toBe(first);
  });

  test("a coordinate change animates along the great circle and settles", () => {
    const store = new SceneModelPresentationStateStore();
    const start: GeoCoordinate = { latitude: 0, longitude: 0 };
    const target: GeoCoordinate = { latitude: 0, longitude: 0.002 };
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1, { longitude: target.longitude })]), 10);
    expect(store.hasActiveAnimations).toBe(true);

    const duration = SceneModelAnimationMath.positionAnimationDuration(start, target);
    expect(duration).toBeGreaterThan(0);
    const midLongitude = longitudeOf(store.presentedEntries(10 + duration * 0.5)[0]!);
    expect(midLongitude).toBeGreaterThan(0);
    expect(midLongitude).toBeLessThan(target.longitude);

    const settled = store.presentedEntries(10 + duration + 0.01)[0]!;
    expect(settled.projectionBasis).toEqual(GeoProjectionBasis.fromCoordinate(target));
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("a transform change animates with eased progress", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1, { headingDegrees: 90, scale: 3, altitudeMeters: 40 })], { durations: [[1, 1]] }), 100);
    expect(store.hasActiveAnimations).toBe(true);

    const atStart = store.presentedEntries(100)[0]!;
    expectClose(atStart.scale, 1, 1e-9);
    expectClose(atStart.altitudeMeters, 0, 1e-9);

    // Cubic ease-out at raw progress 0.5 is 0.875.
    const eased = SceneModelAnimationMath.easedProgress(0.5);
    const mid = store.presentedEntries(100.5)[0]!;
    expectClose(mid.scale, 1 + 2 * eased, 1e-6);
    expectClose(mid.altitudeMeters, 40 * eased, 1e-6);
    const expectedMid = SceneModelAnimationMath.orientation(
      SceneModelAnimationMath.orientationQuaternion(0, 0, 0),
      SceneModelAnimationMath.orientationQuaternion(90, 0, 0),
      eased,
    );
    expectClose(Math.abs(quatDot(mid.orientation, expectedMid)), 1, 1e-5);

    const settled = store.presentedEntries(101.01)[0]!;
    expectClose(settled.scale, 3, 1e-9);
    expectClose(settled.altitudeMeters, 40, 1e-9);
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("a transform with zero duration snaps", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1, { scale: 5 })]), 1);
    expectClose(store.presentedEntries(1)[0]!.scale, 5, 1e-9);
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("a removed model disappears from the presentation", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1), makeModel(2)]), 0);
    expect(store.presentedEntries(0)).toHaveLength(2);
    store.apply(makeSnapshot([makeModel(2)]), 1);
    expect(store.presentedEntries(1).map((entry) => entry.id)).toEqual([2]);
    expect(store.isEmpty).toBe(false);
    store.apply(makeSnapshot([]), 2);
    expect(store.isEmpty).toBe(true);
  });

  test("the presented model carries the descriptor's source, fit and ground cut", () => {
    const store = new SceneModelPresentationStateStore();
    const model = ImmersiveMapSceneModel.make({ id: 3, source: "a.glb", coordinate: { latitude: 0, longitude: 0 }, fitDiameterMeters: 12, cutsIntoGround: true });
    store.apply(makeSnapshot([model]), 0);
    const presented = store.presentedEntries(0)[0]!;
    expect(presented.source).toBe(model.source);
    expect(presented.fitDiameterMeters).toBe(12);
    expect(presented.cutsIntoGround).toBe(true);
    expect(presented.coordinate).toEqual(model.coordinate);
  });
});

// Path animations

const pathStart: GeoCoordinate = { latitude: 0, longitude: 0 };
const pathEnd: GeoCoordinate = { latitude: 0, longitude: 60 };

function makeRequest(
  duration: number,
  options: { curve?: ImmersiveMapPathAnimationCurve; peakAltitudeMeters?: number; appliesHeading?: boolean; appliesPitch?: boolean } = {},
): SceneModelPathAnimationRequest {
  return {
    generation: 1,
    path: ImmersiveMapGeoPath.make([pathStart, pathEnd], { peakAltitudeMeters: options.peakAltitudeMeters ?? 0 }),
    duration,
    curve: options.curve ?? "linear",
    appliesHeading: options.appliesHeading ?? true,
    appliesPitch: options.appliesPitch ?? true,
  };
}

function expectCoordinate(presented: PresentedSceneModel, expected: GeoCoordinate): void {
  expect(presented.projectionBasis).toEqual(GeoProjectionBasis.fromCoordinate(expected));
}

function expectForward(actual: Quat, expected: Quat): void {
  const actualForward = quatAct(actual, [0, 1, 0]);
  const expectedForward = quatAct(expected, [0, 1, 0]);
  for (let axis = 0; axis < 3; axis++) expectClose(actualForward[axis]!, expectedForward[axis]!, 1e-4);
}

describe("scene model path animations", () => {
  test("the model travels from the first waypoint to the last", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 100);
    expect(store.hasActiveAnimations).toBe(true);
    expectCoordinate(store.presentedEntries(100)[0]!, pathStart);
    expectCoordinate(store.presentedEntries(110)[0]!, pathEnd);
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("the altitude follows the profile", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10, { peakAltitudeMeters: 400_000 })]] }), 0);
    expectClose(store.presentedEntries(0)[0]!.altitudeMeters, 0, 1e-6);
    expectClose(store.presentedEntries(5)[0]!.altitudeMeters, 400_000, 1e-3);
    expectClose(store.presentedEntries(10)[0]!.altitudeMeters, 0, 1e-6);
  });

  test("the linear and ease-out curves differ at the midpoint", () => {
    const linear = new SceneModelPresentationStateStore();
    linear.apply(makeSnapshot([makeModel(1)]), 0);
    linear.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10, { curve: "linear" })]] }), 0);
    const eased = new SceneModelPresentationStateStore();
    eased.apply(makeSnapshot([makeModel(1)]), 0);
    eased.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10, { curve: "easeOut" })]] }), 0);
    // Cubic ease-out at raw progress 0.5 is 0.875.
    expectClose(longitudeOf(linear.presentedEntries(5)[0]!), 30, 1e-4);
    expectClose(longitudeOf(eased.presentedEntries(5)[0]!), 52.5, 1e-4);
  });

  test("the heading follows the trajectory when enabled", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    // Eastbound along the equator: heading 90.
    expectForward(store.presentedEntries(5)[0]!.orientation, SceneModelAnimationMath.orientationQuaternion(90, 0, 0));
  });

  test("the heading is left alone when disabled", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1, { headingDegrees: 12 })]), 0);
    store.apply(makeSnapshot([makeModel(1, { headingDegrees: 12 })], { pathAnimations: [[1, makeRequest(10, { appliesHeading: false })]] }), 0);
    expectForward(store.presentedEntries(5)[0]!.orientation, SceneModelAnimationMath.orientationQuaternion(12, 0, 0));
  });

  test("climbing pitches the nose up and descending pitches it down", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10, { peakAltitudeMeters: 400_000 })]] }), 0);
    // Tangent frame: east +X, north +Y, up +Z. Heading 90 turns forward to
    // east, so the climb must lift the forward axis toward up.
    expect(quatAct(store.presentedEntries(1)[0]!.orientation, [0, 1, 0])[2]).toBeGreaterThan(0);
    expect(quatAct(store.presentedEntries(9)[0]!.orientation, [0, 1, 0])[2]).toBeLessThan(0);
  });

  test("the path wins over a concurrent move", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    // An unrelated mutation resends every model, here with a move target far
    // off the path: the path must keep the position.
    store.apply(makeSnapshot([makeModel(1, { latitude: 70, longitude: -140 })]), 5);
    const presented = store.presentedEntries(5)[0]!;
    expectClose(longitudeOf(presented), 30, 1e-4);
    expectClose(latitudeOf(presented), 0, 1e-4);
    expect(store.hasActiveAnimations).toBe(true);
  });

  test("a cancellation leaves the model where it is", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    store.presentedEntries(5);
    store.apply(makeSnapshot([makeModel(1)], { cancelled: [1] }), 5);
    expect(store.hasActiveAnimations).toBe(false);
    expectClose(longitudeOf(store.presentedEntries(9)[0]!), 30, 1e-4);
  });

  test("a finished flight is reported exactly once", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    store.presentedEntries(5);
    expect(store.consumePathAnimationResults()).toEqual([]);
    store.presentedEntries(10);
    expect(store.consumePathAnimationResults().map((result) => [result.id, result.finished])).toEqual([[1, true]]);
    store.presentedEntries(11);
    expect(store.consumePathAnimationResults()).toEqual([]);
  });

  test("a cancelled flight reports where it stopped and not success", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    store.presentedEntries(5);
    store.apply(makeSnapshot([makeModel(1)], { cancelled: [1] }), 5);
    const results = store.consumePathAnimationResults();
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(1);
    expect(results[0]!.finished).toBe(false);
    expectClose(results[0]!.coordinate.longitude, 30, 1e-4);
    store.presentedEntries(20);
    expect(store.consumePathAnimationResults()).toEqual([]);
  });

  test("the landing does not snap back on a later snapshot", () => {
    const store = new SceneModelPresentationStateStore();
    const landed = makeModel(1, { latitude: pathEnd.latitude, longitude: pathEnd.longitude, headingDegrees: 90 });
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([landed], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    store.presentedEntries(10);
    store.apply(makeSnapshot([landed]), 11);
    expect(store.hasActiveAnimations).toBe(false);
    expectCoordinate(store.presentedEntries(11)[0]!, pathEnd);
  });

  test("a model added and animated in the same snapshot starts at the path's start", () => {
    const store = new SceneModelPresentationStateStore();
    const landed = makeModel(1, { latitude: pathEnd.latitude, longitude: pathEnd.longitude });
    store.apply(makeSnapshot([landed], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    expect(store.hasActiveAnimations).toBe(true);
    expectCoordinate(store.presentedEntries(0)[0]!, pathStart);
    expectClose(longitudeOf(store.presentedEntries(5)[0]!), 30, 1e-4);
    expectCoordinate(store.presentedEntries(10)[0]!, pathEnd);
  });

  test("a zero duration lands and reports on the first frame", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(0)]] }), 3);
    expectCoordinate(store.presentedEntries(3)[0]!, pathEnd);
    expect(store.consumePathAnimationResults().map((result) => result.id)).toEqual([1]);
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("the scale still applies while flying", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1, { scale: 4 })], { durations: [[1, 0]], pathAnimations: [[1, makeRequest(10)]] }), 0);
    expectClose(store.presentedEntries(1)[0]!.scale, 4, 1e-9);
    store.apply(makeSnapshot([makeModel(1, { scale: 7 })], { durations: [[1, 0]] }), 2);
    expectClose(store.presentedEntries(2)[0]!.scale, 7, 1e-9);
    // The flight is untouched by the scale change.
    expectClose(longitudeOf(store.presentedEntries(5)[0]!), 30, 1e-4);
  });

  test("a move during a flight is ignored and does not resurface later", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, makeRequest(10)]] }), 0);
    store.apply(makeSnapshot([makeModel(1, { latitude: 70, longitude: -140 })]), 5);
    // Lands at the end of the path, not at the swallowed move target.
    store.presentedEntries(10);
    expectCoordinate(store.presentedEntries(10)[0]!, pathEnd);
    // And a snapshot after the flight does not resurrect it either.
    store.apply(makeSnapshot([makeModel(1, { latitude: pathEnd.latitude, longitude: pathEnd.longitude })]), 11);
    expect(store.hasActiveAnimations).toBe(false);
    expectCoordinate(store.presentedEntries(11)[0]!, pathEnd);
  });

  test("a degenerate path starts no animation", () => {
    const store = new SceneModelPresentationStateStore();
    store.apply(makeSnapshot([makeModel(1)]), 0);
    const request: SceneModelPathAnimationRequest = { ...makeRequest(10), path: ImmersiveMapGeoPath.make([pathStart]) };
    store.apply(makeSnapshot([makeModel(1)], { pathAnimations: [[1, request]] }), 0);
    expect(store.hasActiveAnimations).toBe(false);
    expectCoordinate(store.presentedEntries(5)[0]!, pathStart);
  });
});
