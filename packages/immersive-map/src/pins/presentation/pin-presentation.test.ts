// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `PinPresentationStateStoreTests` and `PinVisibilityFadeStateStoreTests`.

import { describe, expect, test } from "vitest";
import { GeoProjectionBasis } from "../../geo/geo-projection-basis.ts";
import type { ProjectedPin } from "../clustering/pin-collision-types.ts";
import { ImmersiveMapPin, type PinImage } from "../immersive-map-pin.ts";
import type { PinsSnapshot } from "../immersive-map-pins-controller.ts";
import { PinAnimationMath, PinPresentationStateStore, PinSelectionAnimationMath } from "./pin-presentation-state-store.ts";
import { PinVisibilityFadeStateStore } from "./pin-visibility-fade-state-store.ts";

const picture = {} as unknown as PinImage;

function makePin(id: number, drawPriority = 0, latitude = 0, longitude = id): ImmersiveMapPin {
  return ImmersiveMapPin.make({ id, coordinate: { latitude, longitude }, image: picture, drawPriority });
}

function snapshot(pins: ImmersiveMapPin[]): PinsSnapshot {
  return { pins, removedIds: [], imageUpdateIds: [], version: 1 };
}

describe("PinPresentationStateStore", () => {
  test("the presented entries go by id, with draw order ranks by (drawPriority, id)", () => {
    const store = new PinPresentationStateStore();
    store.apply(snapshot([makePin(5, 0), makePin(1, 2), makePin(9, 1)]), 0);
    const presented = store.presentedEntries(0);
    expect(presented.map((entry) => entry.pin.id)).toEqual([1, 5, 9]);
    expect(presented.map((entry) => entry.drawOrder)).toEqual([2, 0, 1]);
  });

  test("still pins return the cached list and report no animation", () => {
    const store = new PinPresentationStateStore();
    store.apply(snapshot([1, 2, 3, 4, 5].map((id) => makePin(id))), 0);
    const first = store.presentedEntries(0.5);
    expect(store.hasActiveAnimations).toBe(false);
    const second = store.presentedEntries(1);
    expect(second).toBe(first);
    expect(first[2]!.pin.coordinate.latitude).toBe(second[2]!.pin.coordinate.latitude);
  });

  test("a coordinate change animates and refreshes the projection basis", () => {
    const store = new PinPresentationStateStore();
    const pin = makePin(7);
    store.apply(snapshot([pin]), 0);
    store.presentedEntries(0);
    store.apply(snapshot([ImmersiveMapPin.with(pin, { coordinate: { latitude: 10, longitude: 20 } })]), 1);
    expect(store.hasActiveAnimations).toBe(true);
    const midway = store.presentedEntries(1.2)[0]!;
    expect(midway.pin.coordinate.latitude).toBeGreaterThan(0);
    expect(midway.pin.coordinate.latitude).toBeLessThan(10);
    const settled = store.presentedEntries(5)[0]!;
    expect(settled.pin.coordinate.latitude).toBeCloseTo(10, 9);
    expect(settled.pin.coordinate.longitude).toBeCloseTo(20, 9);
    const expected = GeoProjectionBasis.fromCoordinate(settled.pin.coordinate);
    expect(settled.projectionBasis.sphereUnit[0]).toBeCloseTo(expected.sphereUnit[0], 6);
    expect(settled.projectionBasis.sphereUnit[1]).toBeCloseTo(expected.sphereUnit[1], 6);
    expect(settled.projectionBasis.mercatorYNormalized).toBeCloseTo(expected.mercatorYNormalized, 12);
    store.presentedEntries(5.1);
    expect(store.hasActiveAnimations).toBe(false);
  });

  test("pins left out of the snapshot leave the presented list", () => {
    const store = new PinPresentationStateStore();
    const pins = [1, 2, 3].map((id) => makePin(id));
    store.apply(snapshot(pins), 0);
    expect(store.presentedEntries(0)).toHaveLength(3);
    store.apply(snapshot([pins[1]!]), 1);
    expect(store.presentedEntries(1).map((entry) => entry.pin.id)).toEqual([2]);
  });

  test("a selected pin breathes and keeps the store animating", () => {
    const store = new PinPresentationStateStore();
    store.apply(snapshot([ImmersiveMapPin.with(makePin(1), { isSelected: true })]), 0);
    expect(store.hasActiveAnimations).toBe(true);
    const entry = store.presentedEntries(0.4)[0]!;
    expect(entry.squashScaleX).toBeLessThan(1);
    expect(entry.squashScaleX).toBeGreaterThanOrEqual(PinSelectionAnimationMath.minimumScale - 1e-6);
  });
});

describe("PinAnimationMath", () => {
  test("a longer trip takes longer, up to the maximum, and no trip takes no time", () => {
    const start = { latitude: 55.75, longitude: 37.62 };
    expect(PinAnimationMath.animationDuration(start, start)).toBe(0);
    const near = PinAnimationMath.animationDuration(start, { latitude: 55.7501, longitude: 37.62 });
    const far = PinAnimationMath.animationDuration(start, { latitude: 56.75, longitude: 37.62 });
    expect(near).toBeGreaterThan(PinAnimationMath.minimumDuration);
    expect(far).toBeCloseTo(PinAnimationMath.maximumDuration, 9);
  });

  test("the great circle's ends are the trip's ends", () => {
    const start = { latitude: 10, longitude: 20 };
    const target = { latitude: -30, longitude: 100 };
    expect(PinAnimationMath.coordinate(start, target, 0)).toBe(start);
    expect(PinAnimationMath.coordinate(start, target, 1)).toBe(target);
    const middle = PinAnimationMath.coordinate(start, target, 0.5);
    expect(middle.longitude).toBeGreaterThan(20);
    expect(middle.longitude).toBeLessThan(100);
  });
});

describe("PinVisibilityFadeStateStore", () => {
  const projected = (id: number, visibilityAlpha: number): ProjectedPin => ({
    pin: makePin(id, 0, 0, 0),
    squashScaleX: 1,
    squashScaleY: 1,
    screenPoint: { positionX: 20, positionY: 30, depth: 0.5, visible: 1, visibilityAlpha },
    worldX: 0.02,
    worldY: 0.03,
    drawOrder: 0,
  });

  test("a pin fades out when its visibility drops to zero", () => {
    const store = new PinVisibilityFadeStateStore();
    store.resolve([projected(1, 1)], 0, 0.15, 0.25);
    store.resolve([projected(1, 0)], 0, 0.15, 0.25);
    const resolution = store.resolve([projected(1, 0)], 0.125, 0.15, 0.25);
    expect(resolution.projectedPins).toHaveLength(1);
    expect(resolution.projectedPins[0]!.screenPoint.visibilityAlpha).toBeCloseTo(0.5, 4);
    expect(resolution.hasActiveAnimations).toBe(true);
  });

  test("a pin leaves once its fade out completes", () => {
    const store = new PinVisibilityFadeStateStore();
    store.resolve([projected(1, 1)], 0, 0.15, 0.25);
    store.resolve([projected(1, 0)], 0, 0.15, 0.25);
    const resolution = store.resolve([projected(1, 0)], 0.3, 0.15, 0.25);
    expect(resolution.projectedPins).toEqual([]);
    expect(resolution.hasActiveAnimations).toBe(false);
  });

  test("a pin fades in when it comes back after a fade out", () => {
    const store = new PinVisibilityFadeStateStore();
    store.resolve([projected(1, 1)], 0, 0.15, 0.25);
    store.resolve([projected(1, 0)], 0, 0.15, 0.25);
    store.resolve([projected(1, 0)], 0.3, 0.15, 0.25);
    store.resolve([projected(1, 1)], 0.3, 0.15, 0.25);
    const resolution = store.resolve([projected(1, 1)], 0.375, 0.15, 0.25);
    expect(resolution.projectedPins).toHaveLength(1);
    expect(resolution.projectedPins[0]!.screenPoint.visibilityAlpha).toBeCloseTo(0.5, 4);
    expect(resolution.hasActiveAnimations).toBe(true);
  });

  test("a faded pin keeps its world position for the solver's grid", () => {
    const store = new PinVisibilityFadeStateStore();
    store.resolve([projected(1, 1)], 0, 0.15, 0.25);
    const resolution = store.resolve([projected(1, 0.5)], 0.1, 0.15, 0.25);
    expect(resolution.projectedPins[0]!.worldX).toBe(0.02);
  });
});
