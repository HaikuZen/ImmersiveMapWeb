// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type CameraSettings, cameraSettings, defaultCameraSettings, globeBearingLimit } from "../configuration/camera-settings.ts";
import { type CameraConstraints, CameraConstraintResolver } from "./camera-constraint-resolver.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import type { ViewMode } from "./view-mode.ts";

const degrees = (value: number): number => (value * Math.PI) / 180;

describe("CameraConstraintResolver", () => {
  function resolve(renderSurfaceMode: ViewMode, zoom = 10, settings: CameraSettings = defaultCameraSettings): CameraConstraints {
    return CameraConstraintResolver.resolve(ImmersiveMapCameraState.make([0.5, 0.5], zoom, 0, 0), settings, renderSurfaceMode);
  }

  function globeMaximumBearing(zoom: number, settings: CameraSettings): number {
    const maximum = resolve("spherical", zoom, settings).bearing.maximumAbsoluteBearing;
    expect(maximum, "A capped globe bearing is never unbounded.").not.toBeNull();
    return maximum ?? Number.NaN;
  }

  test("the flat pitch limit is always 85 degrees", () => {
    for (const zoom of [0, 12, 20]) {
      expect(resolve("flat", zoom).pitch.maximumPitch).toBeCloseTo(degrees(85), 4);
    }
  });

  /**
   * The globe's ceiling no longer eases in with zoom: it is the flat map's
   * fixed 85 degrees at every zoom, the whole planet included.
   */
  test("the globe pitch limit is always 85 degrees", () => {
    for (const zoom of [0, 1.5, 3, 20]) {
      expect(resolve("spherical", zoom).pitch.maximumPitch).toBeCloseTo(degrees(85), 4);
    }
  });

  test("the defaults leave the pitch floor, the bearing cap and the bounds off", () => {
    // Every camera limit is opt-in: a reachable top-down view, unbounded
    // rotation on both surfaces at every zoom, and the whole world open.
    expect(defaultCameraSettings.minimumPitch).toBe(0);
    expect(defaultCameraSettings.maximumAbsoluteBearing).toBeNull();
    expect(defaultCameraSettings.globeBearingLimit).toBeNull();
    expect(defaultCameraSettings.bounds).toBeNull();
    expect(resolve("flat").bearing.maximumAbsoluteBearing).toBeNull();
    expect(resolve("spherical", 0).bearing.maximumAbsoluteBearing).toBeNull();
  });

  test("a globe bearing cap without a window applies at every zoom", () => {
    const settings = cameraSettings({ maximumAbsoluteBearing: Math.PI / 2 });
    expect(globeMaximumBearing(0, settings)).toBeCloseTo(Math.PI / 2, 4);
    expect(globeMaximumBearing(20, settings)).toBeCloseTo(Math.PI / 2, 4);
  });

  test("the flat pitch floor holds at every zoom", () => {
    const settings = cameraSettings({ minimumPitch: 0.35 });
    expect(resolve("flat", 0, settings).pitch.apply(0)).toBeCloseTo(0.35, 4);
    expect(resolve("flat", 20, settings).pitch.apply(0)).toBeCloseTo(0.35, 4);
  });

  /**
   * The globe's ceiling is the flat map's at every zoom, so a floor under it
   * holds on the sphere exactly as it does on the plane.
   */
  test("the globe pitch floor holds at every zoom", () => {
    const settings = cameraSettings({ minimumPitch: 0.35 });
    expect(resolve("spherical", 0, settings).pitch.apply(0)).toBeCloseTo(0.35, 4);
    expect(resolve("spherical", 0, settings).pitch.apply(0.9)).toBeCloseTo(0.9, 4);
    expect(resolve("spherical", 3, settings).pitch.apply(0)).toBeCloseTo(0.35, 4);
  });

  test("the flat bearing cap clamps the rotation", () => {
    const bearing = resolve("flat", 10, cameraSettings({ maximumAbsoluteBearing: Math.PI / 2 })).bearing;
    expect(bearing.apply(2.5)).toBeCloseTo(Math.PI / 2, 4);
    expect(bearing.apply(-2.5)).toBeCloseTo(-Math.PI / 2, 4);
  });

  test("the globe bearing window opens to the cap instead of the half turn", () => {
    // Window floor 15 degrees, unlocked at zoom 6. The cap replaces the half
    // turn as the widest the window opens.
    const settings = cameraSettings({ maximumAbsoluteBearing: Math.PI / 2, globeBearingLimit: globeBearingLimit(Math.PI / 12, 6) });
    const floor = Math.PI / 12;
    expect(globeMaximumBearing(0, settings)).toBeCloseTo(floor, 4);
    expect(globeMaximumBearing(3, settings)).toBeCloseTo(floor + (Math.PI / 2 - floor) * 0.5, 4);
    expect(globeMaximumBearing(6, settings)).toBeCloseTo(Math.PI / 2, 4);
    expect(globeMaximumBearing(20, settings)).toBeCloseTo(Math.PI / 2, 4);
  });

  test("a globe bearing cap below the window's floor collapses the window", () => {
    const settings = cameraSettings({ maximumAbsoluteBearing: Math.PI / 24, globeBearingLimit: globeBearingLimit(Math.PI / 12, 6) });
    expect(globeMaximumBearing(0, settings)).toBeCloseTo(Math.PI / 24, 4);
    expect(globeMaximumBearing(20, settings)).toBeCloseTo(Math.PI / 24, 4);
  });
});
