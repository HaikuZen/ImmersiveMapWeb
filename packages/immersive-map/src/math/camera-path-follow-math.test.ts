// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { geoCoordinate } from "../geo/geo-coordinate.ts";
import { pathAnimationFraction } from "../geo/immersive-map-path-animation-curve.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { CameraBearingFollowMath } from "./camera-bearing-follow-math.ts";
import { CameraPathFollowMath } from "./camera-path-follow-math.ts";
import type { Vec2 } from "./vec.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/**
 * The chase math behind a camera following a path: a frame-rate independent
 * catch-up, and a world-X step that crosses the antimeridian the short way.
 */
describe("CameraPathFollowMath", () => {
  // Catch-up

  test("a zero half-life pins the camera on the target", () => {
    expect(CameraPathFollowMath.catchUpFraction(1.0 / 60.0, 0)).toBe(1);
    expect(CameraPathFollowMath.catchUpFraction(1.0 / 60.0, -1)).toBe(1);
  });

  test("one half-life closes half the gap", () => {
    // The delta time cap is what makes this reachable in one step.
    const halfLife = CameraPathFollowMath.maximumDeltaTime;
    expectClose(CameraPathFollowMath.catchUpFraction(halfLife, halfLife), 0.5, 1e-9);
  });

  /**
   * Two half-steps must close the same share of the gap as one full step,
   * otherwise the chase would depend on the frame rate.
   */
  test("the catch-up is frame-rate independent", () => {
    const halfLife = 0.4;
    const step = 0.02;
    const single = CameraPathFollowMath.catchUpFraction(step * 2, halfLife);
    let remaining = 1.0;
    for (let index = 0; index < 2; index++) {
      remaining *= 1 - CameraPathFollowMath.catchUpFraction(step, halfLife);
    }
    expectClose(1 - remaining, single, 1e-9);
  });

  /** A long stall (a parked view resuming) must not teleport the camera. */
  test("a long frame is capped instead of teleporting", () => {
    const capped = CameraPathFollowMath.catchUpFraction(5, 0.35);
    const atCap = CameraPathFollowMath.catchUpFraction(CameraPathFollowMath.maximumDeltaTime, 0.35);
    expectClose(capped, atCap, 1e-12);
    expect(capped).toBeLessThan(1);
  });

  /**
   * Same convention as the pitch and bearing followers: a non-finite delta
   * time yields no step at all rather than a capped one.
   */
  test("a non-finite delta time is ignored", () => {
    expect(CameraPathFollowMath.clampedDeltaTime(Number.NaN)).toBe(0);
    expect(CameraPathFollowMath.clampedDeltaTime(Number.POSITIVE_INFINITY)).toBe(0);
    expect(CameraPathFollowMath.clampedDeltaTime(-1)).toBe(0);
    expect(CameraBearingFollowMath.clampedDeltaTime(Number.POSITIVE_INFINITY)).toBe(0);
  });

  // Center step

  test("the shortest world X delta crosses the seam", () => {
    // 0.99 -> 0.01 is 0.02 east across the antimeridian, not 0.98 west.
    expectClose(CameraPathFollowMath.shortestNormalizedWorldXDelta(0.99, 0.01), 0.02, 1e-12);
    expectClose(CameraPathFollowMath.shortestNormalizedWorldXDelta(0.01, 0.99), -0.02, 1e-12);
    expectClose(CameraPathFollowMath.shortestNormalizedWorldXDelta(0.2, 0.3), 0.1, 1e-12);
  });

  test("the stepped center crosses the seam and stays wrapped", () => {
    const stepped = CameraPathFollowMath.steppedCenter([0.99, 0.5], [0.01, 0.5], 0.5);
    expectClose(stepped[0], 0.0, 1e-12);
    expect(stepped[0]).toBeGreaterThanOrEqual(0);
    expect(stepped[0]).toBeLessThan(1);
  });

  test("a full catch-up lands exactly on the target", () => {
    const target: Vec2 = [0.25, 0.4];
    const stepped = CameraPathFollowMath.steppedCenter([0.8, 0.9], target, 1);
    expectClose(stepped[0], target[0], 1e-12);
    expectClose(stepped[1], target[1], 1e-12);
  });

  test("repeated steps converge on a static target", () => {
    let center: Vec2 = [0.1, 0.1];
    const target: Vec2 = [0.6, 0.7];
    for (let index = 0; index < 600; index++) {
      center = CameraPathFollowMath.steppedCenter(center, target, CameraPathFollowMath.catchUpFraction(1.0 / 60.0, 0.35));
    }
    expectClose(center[0], target[0], 1e-6);
    expectClose(center[1], target[1], 1e-6);
  });

  // Coordinate conversion

  test("the center in world Mercator round-trips", () => {
    const coordinate = geoCoordinate(48.8566, 2.3522);
    const center = CameraPathFollowMath.centerWorldMercator(coordinate);
    const latitude = (ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]) * 180.0) / Math.PI;
    const longitude = (ImmersiveMapProjection.longitudeFromNormalizedWorldX(center[0]) * 180.0) / Math.PI;
    expectClose(latitude, coordinate.latitude, 1e-9);
    expectClose(longitude, coordinate.longitude, 1e-9);
  });
});

/**
 * The curve is the contract that keeps a followed camera and an animated
 * model on the same point of the path, so it is pinned on its own.
 */
describe("ImmersiveMapPathAnimationCurve", () => {
  test("the linear curve is proportional to the elapsed time", () => {
    expect(pathAnimationFraction("linear", 0, 10)).toBe(0);
    expect(pathAnimationFraction("linear", 5, 10)).toBe(0.5);
    expect(pathAnimationFraction("linear", 10, 10)).toBe(1);
  });

  test("the ease-out is cubic", () => {
    // 1 - (1 - 0.5)^3 = 0.875
    expectClose(pathAnimationFraction("easeOut", 5, 10), 0.875, 1e-12);
  });

  test("the fraction is clamped and degenerate durations finish immediately", () => {
    expect(pathAnimationFraction("linear", -5, 10)).toBe(0);
    expect(pathAnimationFraction("linear", 50, 10)).toBe(1);
    expect(pathAnimationFraction("easeOut", 1, 0)).toBe(1);
  });
});
