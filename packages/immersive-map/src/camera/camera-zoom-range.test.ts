// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type CameraSettings, cameraSettings, clampZoom, defaultCameraSettings } from "../configuration/camera-settings.ts";
import { CameraStateController } from "./camera-state-controller.ts";
import { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";

/**
 * The zoom range is a single funnel: every gesture, command and camera flight
 * ends up in `CameraStateController`, so clamping there is what actually
 * keeps the camera inside `minimumZoom ... maximumZoom`.
 */
describe("Camera zoom range", () => {
  function settings(minimumZoom: number, maximumZoom = 20): CameraSettings {
    return cameraSettings({ minimumZoom, maximumZoom });
  }

  function position(zoom: number): ImmersiveMapCameraPosition {
    return ImmersiveMapCameraPosition.make(0, 0, zoom, 0, 0);
  }

  // Clamping rules

  test("the default settings keep the whole globe reachable", () => {
    // The default range must stay open at the bottom: an app that never
    // touches minimumZoom keeps the globe overview.
    expect(defaultCameraSettings.minimumZoom).toBe(0);
    expect(clampZoom(defaultCameraSettings, 0)).toBe(0);
  });

  test("the clamp pulls the zoom up to the minimum", () => {
    expect(clampZoom(settings(3), 1.2)).toBe(3);
  });

  test("the clamp pushes the zoom down to the maximum", () => {
    expect(clampZoom(settings(3, 18), 25)).toBe(18);
  });

  test("a zoom inside the range is untouched", () => {
    expect(clampZoom(settings(3, 18), 7.5)).toBe(7.5);
  });

  test("a negative minimum behaves like zero", () => {
    // Zoom 0 already shows the whole world, so a negative bound means nothing.
    expect(clampZoom(settings(-5), 0)).toBe(0);
  });

  test("an inverted range collapses to the maximum", () => {
    // A misconfigured range must still produce a reachable zoom rather than
    // clamping to a lower bound above the upper one.
    expect(clampZoom(settings(22, 18), 10)).toBe(18);
  });

  // Camera state

  test("the initial camera state respects the minimum zoom", () => {
    // The default state starts at zoom 0, and the bound must hold from the
    // first frame, not from the first gesture.
    expect(new CameraStateController(settings(5)).zoom).toBe(5);
  });

  test("a zoom out stops at the minimum", () => {
    const controller = new CameraStateController(settings(4));
    controller.setCameraPosition(position(10));
    controller.zoomByDelta(-100);
    expect(controller.zoom).toBe(4);
  });

  test("setting the camera position clamps to the minimum", () => {
    const controller = new CameraStateController(settings(4));
    controller.setCameraPosition(position(0.5));
    expect(controller.zoom).toBe(4);
  });

  /**
   * Camera flights arc out to an overview before diving in, and every flight
   * frame lands here, so this is what keeps a long flight from dipping below
   * the range mid-air.
   */
  test("setting the camera state clamps to the minimum", () => {
    const controller = new CameraStateController(settings(4));
    controller.setCameraState(ImmersiveMapCameraState.make([0.5, 0.5], 0.7, 0, 0));
    expect(controller.zoom).toBe(4);
  });

  test("applying settings pulls the current zoom into the range", () => {
    // Raising the minimum while the map is already zoomed out must move the
    // camera, not leave it stranded outside the new range.
    const controller = new CameraStateController(settings(0));
    controller.setCameraPosition(position(1));
    controller.apply(settings(6));
    expect(controller.zoom).toBe(6);
  });

  test("the camera state from a position clamps to the minimum", () => {
    expect(ImmersiveMapCameraState.fromPosition(position(1), settings(5)).zoom).toBe(5);
  });
});
