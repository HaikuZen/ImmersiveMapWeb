// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CameraFlightAnimator } from "../camera/camera-flight-animator.ts";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { CameraFlightMath, OverviewFlightProfile } from "./camera-flight-math.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/** Swift `CameraFlightOverviewProfileTests`. */
describe("OverviewFlightProfile", () => {
  // Tokyo -> Dubai from the demo storyboard: roughly a quarter of the world in longitude.
  const tokyo = ImmersiveMapProjection.worldMercator((35.6595 * Math.PI) / 180, (139.7005 * Math.PI) / 180);
  const dubai = ImmersiveMapProjection.worldMercator((25.1972 * Math.PI) / 180, (55.2744 * Math.PI) / 180);

  function cityToCityProfile(): OverviewFlightProfile {
    const distance = CameraFlightMath.greatCircleRouteDistance(tokyo, dubai);
    const profile = OverviewFlightProfile.make(16.7, 16.4, distance);
    expect(profile).not.toBeNull();
    return profile!;
  }

  function apexZoom(profile: OverviewFlightProfile): number {
    let minimum = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 100; step++) {
      minimum = Math.min(minimum, profile.sample(step / 100).zoom);
    }
    return minimum;
  }

  test("the profile matches its endpoints", () => {
    const profile = cityToCityProfile();
    const start = profile.sample(0);
    const end = profile.sample(1);
    expectClose(start.zoom, 16.7, 1e-6);
    expectClose(start.panProgress, 0, 1e-6);
    expectClose(end.zoom, 16.4, 1e-3);
    expectClose(end.panProgress, 1, 1e-3);
  });

  test("a long flight pulls out to the globe", () => {
    // An intercontinental flight must climb to the globe view.
    const apex = apexZoom(cityToCityProfile());
    expect(apex).toBeLessThan(4);
    expect(apex).toBeGreaterThanOrEqual(0);
  });

  test("a short flight arcs modestly", () => {
    // Neighboring blocks: about 400 m, the arc must not fly off to the globe.
    const profile = OverviewFlightProfile.make(16.5, 16.5, 1e-5);
    expect(profile).not.toBeNull();
    const apex = apexZoom(profile!);
    expect(apex).toBeGreaterThan(12);
    expect(apex).toBeLessThan(16.5);
  });

  test("the pan progress is monotonic", () => {
    const profile = cityToCityProfile();
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = 0; step <= 200; step++) {
      const panProgress = profile.sample(step / 200).panProgress;
      expect(panProgress).toBeGreaterThanOrEqual(previous);
      previous = panProgress;
    }
  });

  test("the pan crawls near the ground and cruises at the apex", () => {
    // During the first tenth of the path (near the ground) the center barely
    // moves. The middle of the flight (the apex) covers most of the distance.
    const profile = cityToCityProfile();
    const nearGround = profile.sample(0.1).panProgress;
    const beforeMiddle = profile.sample(0.35).panProgress;
    const afterMiddle = profile.sample(0.65).panProgress;
    expect(nearGround).toBeLessThan(0.01);
    expect(afterMiddle - beforeMiddle).toBeGreaterThan(0.5);
  });

  test("a degenerate distance returns null", () => {
    expect(OverviewFlightProfile.make(3, 15, 0)).toBeNull();
  });

  test("the route distances agree in scale", () => {
    // Both metrics are in normalized world units: for equatorial points the
    // arc and the Mercator path are close in length.
    const a = ImmersiveMapProjection.worldMercator(0, 0);
    const b = ImmersiveMapProjection.worldMercator(0, Math.PI / 2);
    expectClose(CameraFlightMath.mercatorRouteDistance(a, b), 0.25, 1e-9);
    expectClose(CameraFlightMath.greatCircleRouteDistance(a, b), 0.25, 1e-9);
  });

  test("an overview flight of the animator dips its zoom and arrives", () => {
    const animator = new CameraFlightAnimator();
    const startState = ImmersiveMapCameraState.make(tokyo, 16.7, 0.55, 1.02);
    const targetState = ImmersiveMapCameraState.make(dubai, 16.4, -0.35, 1.0);
    expect(animator.start(startState, targetState, 6.0, "greatCircle", "overviewFirst", 0)).toBe(true);

    let minZoom = Number.POSITIVE_INFINITY;
    let lastState: ImmersiveMapCameraState | null = null;
    for (let step = 1; step <= 120; step++) {
      const result = animator.advance((6.0 * step) / 120);
      if (result === null) {
        break;
      }
      minZoom = Math.min(minZoom, result.cameraState.zoom);
      lastState = result.cameraState;
    }

    expect(minZoom).toBeLessThan(4);
    expect(lastState).not.toBeNull();
    expectClose(lastState!.zoom, 16.4, 1e-3);
    expectClose(lastState!.centerWorldMercator[0], dubai[0], 1e-6);
    expectClose(lastState!.centerWorldMercator[1], dubai[1], 1e-6);
    expect(animator.isActive).toBe(false);
  });
});
