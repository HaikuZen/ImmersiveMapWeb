// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type CameraSettings, cameraSettings, clampPitch, defaultCameraSettings } from "../configuration/camera-settings.ts";
import { CameraConstraintResolver } from "./camera-constraint-resolver.ts";
import { CameraStateController } from "./camera-state-controller.ts";
import { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";

/**
 * The pitch range is the same funnel as the zoom range: every gesture,
 * command and flight frame lands in `CameraStateController`, so clamping
 * there is what actually keeps the camera between `minimumPitch` and
 * `maximumPitch`.
 */
describe("Camera pitch range", () => {
  function settings(minimumPitch: number, maximumPitch: number = defaultCameraSettings.maximumPitch): CameraSettings {
    return cameraSettings({ minimumPitch, maximumPitch });
  }

  function position(pitch: number, zoom = 10): ImmersiveMapCameraPosition {
    return ImmersiveMapCameraPosition.make(0, 0, zoom, 0, pitch);
  }

  // Clamping rules

  test("the default settings keep the top-down view reachable", () => {
    expect(defaultCameraSettings.minimumPitch).toBe(0);
    expect(clampPitch(defaultCameraSettings, 0, 10)).toBe(0);
  });

  test("the clamp pulls the pitch up to the floor", () => {
    expect(clampPitch(settings(0.4), 0.1, 10)).toBeCloseTo(0.4, 4);
  });

  test("the clamp pushes the pitch down to the ceiling", () => {
    expect(clampPitch(settings(0.4, 1.0), 1.5, 10)).toBeCloseTo(1.0, 4);
  });

  test("a pitch inside the range is untouched", () => {
    expect(clampPitch(settings(0.4, 1.0), 0.7, 10)).toBeCloseTo(0.7, 4);
  });

  test("a negative floor behaves like zero", () => {
    expect(clampPitch(settings(-1), -0.5, 10)).toBe(0);
  });

  test("a floor above the ceiling collapses to the ceiling", () => {
    // A misconfigured range must still produce a reachable pitch rather than
    // clamping to a floor above the ceiling.
    expect(clampPitch(settings(2.0, 1.0), 0.2, 10)).toBeCloseTo(1.0, 4);
  });

  // Camera state funnel

  test("the initial camera state respects the floor", () => {
    expect(new CameraStateController(settings(0.4)).pitch).toBeCloseTo(0.4, 4);
  });

  test("setting the pitch stops at the floor", () => {
    const controller = new CameraStateController(settings(0.4));
    controller.setCameraPosition(position(0.8));
    controller.setPitch(0);
    expect(controller.pitch).toBeCloseTo(0.4, 4);
  });

  test("setting the camera position clamps the pitch to the floor", () => {
    const controller = new CameraStateController(settings(0.4));
    controller.setCameraPosition(position(0.1));
    expect(controller.pitch).toBeCloseTo(0.4, 4);
  });

  /**
   * Camera flights interpolate a raw state per frame and every one of those
   * frames lands here, so this is what keeps a flight from dipping below the
   * floor mid-air.
   */
  test("setting the camera state clamps the pitch to the floor", () => {
    const controller = new CameraStateController(settings(0.4));
    controller.setCameraState(ImmersiveMapCameraState.make([0.5, 0.5], 10, 0, 0.05));
    expect(controller.pitch).toBeCloseTo(0.4, 4);
  });

  test("applying settings pulls the current pitch up to the floor", () => {
    const controller = new CameraStateController(settings(0));
    controller.setCameraPosition(position(0.1));
    controller.apply(settings(0.5));
    expect(controller.pitch).toBeCloseTo(0.5, 4);
  });

  test("the camera state from a position clamps the pitch to the floor", () => {
    expect(ImmersiveMapCameraState.fromPosition(position(0.1), settings(0.4)).pitch).toBeCloseTo(0.4, 4);
  });

  // Floor versus the globe ceiling

  /**
   * The globe's ceiling is the flat map's fixed one at every zoom, so a
   * default state the floor lifts to a tilt keeps that tilt when the surface
   * constraints are applied at zoom 0.
   */
  test("a zoomed-out globe constraint keeps the floored default state", () => {
    const floored = settings(0.35);
    const controller = new CameraStateController(floored);
    expect(controller.pitch).toBeCloseTo(0.35, 4);
    const constraints = CameraConstraintResolver.resolve(controller.currentCameraState(), floored, "spherical");
    controller.clampPitch(constraints.pitch);
    expect(controller.pitch).toBeCloseTo(0.35, 4);
  });
});
