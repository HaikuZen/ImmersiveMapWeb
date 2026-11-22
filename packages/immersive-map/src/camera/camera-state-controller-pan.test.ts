// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultCameraSettings } from "../configuration/camera-settings.ts";
import type { Vec2 } from "../math/vec.ts";
import { CameraStateController } from "./camera-state-controller.ts";
import { GlobeCameraProximity } from "./globe-camera-proximity.ts";
import { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/**
 * Panning the globe must preserve angular speed at any latitude: the Mercator
 * delta is compensated by `cos(latitude)`. Vertical compensation is full at
 * any zoom. Horizontal ramps in by zoom (at low zooms the whole globe is
 * visible, and a compensated horizontal swipe would spin it like a top). On
 * the flat map (transition = 1) the delta does not depend on latitude.
 */
describe("CameraStateController pan", () => {
  function panDelta(latitudeDegrees: number, zoom: number, transition: number): Vec2 {
    const controller = new CameraStateController(defaultCameraSettings);
    controller.setCameraPosition(ImmersiveMapCameraPosition.make(latitudeDegrees, 0, zoom, 0, 0));
    const before = controller.cameraState.centerWorldMercator;
    controller.pan(10, 10, transition);
    const after = controller.cameraState.centerWorldMercator;
    return [after[0] - before[0], after[1] - before[1]];
  }

  /** Angular latitude delta from a small vertical pan on the globe. */
  function angularLatitudeDelta(latitudeDegrees: number): number {
    const controller = new CameraStateController(defaultCameraSettings);
    controller.setCameraPosition(ImmersiveMapCameraPosition.make(latitudeDegrees, 0, 4, 0, 0));
    const latitudeBefore = controller.getLatLonRad().latRad;
    controller.pan(0, 1, 0);
    return Math.abs(controller.getLatLonRad().latRad - latitudeBefore);
  }

  test("a globe pan moves the same Mercator at local zoom", () => {
    const equator = panDelta(0, 5.5, 0);
    const lat60 = panDelta(60, 5.5, 0);
    // At local zoom the camera has moved in by cos(60) = 0.5
    // (GlobeCameraProximity), so the screen shows the Mercator scale and a
    // swipe moves the same Mercator delta as at the equator.
    expectClose(lat60[0] / equator[0], 1.0, 1e-6);
    expectClose(lat60[1] / equator[1], 1.0, 1e-6);
  });

  test("a globe pan compensates latitude below the proximity activation", () => {
    const equator = panDelta(0, 2, 0);
    const lat60 = panDelta(60, 2, 0);
    // Below the activation zoom the camera stays at the zoom's distance:
    // cos(60) = 0.5, so the vertical Mercator delta is twice the equatorial
    // one (the horizontal one ramps in separately).
    expectClose(lat60[1] / equator[1], 2.0, 1e-6);
  });

  test("a globe pan skips the horizontal compensation at the globe overview zoom", () => {
    const equator = panDelta(0, 1.5, 0);
    const lat60 = panDelta(60, 1.5, 0);
    // Overview zoom: the vertical is compensated, the horizontal spins the
    // globe at the same angular speed as at the equator.
    expectClose(lat60[0] / equator[0], 1.0, 1e-6);
    expectClose(lat60[1] / equator[1], 2.0, 1e-6);
  });

  /**
   * The ground under the finger follows the finger: with the camera moved in
   * by the surface scale, the angular pan per screen point shrinks by that
   * same scale, exactly as the ground on screen did.
   */
  test("the globe pan's angular speed follows the camera proximity", () => {
    const equatorLatitude = angularLatitudeDelta(0);
    const polarLatitude = angularLatitudeDelta(82.8);
    const proximity = GlobeCameraProximity.distanceFactor((82.8 * Math.PI) / 180, 0, 4);
    expectClose(polarLatitude / equatorLatitude, proximity, 0.05 * proximity);
  });

  test("a flat pan ignores latitude", () => {
    const equator = panDelta(0, 8, 1);
    const lat60 = panDelta(60, 8, 1);
    expectClose(lat60[0], equator[0], 1e-12);
    expectClose(lat60[1], equator[1], 1e-12);
  });

  test("a globe pan stays finite near the Mercator latitude limit", () => {
    const nearLimit = panDelta(85, 5.5, 0);
    expect(Number.isFinite(nearLimit[0])).toBe(true);
    expect(Number.isFinite(nearLimit[1])).toBe(true);
  });
});
