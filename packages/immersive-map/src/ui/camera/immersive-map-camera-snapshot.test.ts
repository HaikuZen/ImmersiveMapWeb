// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CameraBearingConstraint, type CameraConstraints, CameraPitchConstraint } from "../../camera/camera-constraint-resolver.ts";
import { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import {
  ImmersiveMapCameraAngleLimits,
  ImmersiveMapCameraBearingLimits,
  ImmersiveMapCameraSnapshot,
  ImmersiveMapCameraSnapshotResolver,
} from "./immersive-map-camera-snapshot.ts";

const PI = Math.PI;

/** Swift `ImmersiveMapCameraSnapshotTests`. */
describe("ImmersiveMapCameraSnapshot", () => {
  test("angle limits clamp values into the range", () => {
    const limits = new ImmersiveMapCameraAngleLimits(-0.25, 0.5);
    expect(limits.clamped(-1)).toBeCloseTo(-0.25, 4);
    expect(limits.clamped(0.25)).toBeCloseTo(0.25, 4);
    expect(limits.clamped(1)).toBeCloseTo(0.5, 4);
  });

  test("bearing limits expose a symmetric range and clamp the normalized bearing", () => {
    const limits = new ImmersiveMapCameraBearingLimits(PI / 4);
    expect(limits.maximumAbsoluteBearing).toBeCloseTo(PI / 4, 4);
    expect(limits.minimum).toBeCloseTo(-PI / 4, 4);
    expect(limits.maximum).toBeCloseTo(PI / 4, 4);
    expect(limits.clamped(PI / 8)).toBeCloseTo(PI / 8, 4);
    expect(limits.clamped(PI / 2)).toBeCloseTo(PI / 4, 4);
    expect(limits.clamped(PI * 1.75)).toBeCloseTo(-PI / 4, 4);
  });

  test("bearing limits clamp the maximum into the supported range", () => {
    const negative = new ImmersiveMapCameraBearingLimits(-1);
    const oversized = new ImmersiveMapCameraBearingLimits(PI * 2);
    expect(negative.maximumAbsoluteBearing).toBeCloseTo(0, 4);
    expect(negative.minimum).toBeCloseTo(0, 4);
    expect(negative.maximum).toBeCloseTo(0, 4);
    expect(oversized.maximumAbsoluteBearing).toBeCloseTo(PI, 4);
    expect(oversized.minimum).toBeCloseTo(-PI, 4);
    expect(oversized.maximum).toBeCloseTo(PI, 4);
  });

  test("a snapshot clamps the position's pitch and bearing", () => {
    const position = ImmersiveMapCameraPosition.make(55, 37, 3, PI / 2, PI / 3);
    const snapshot = new ImmersiveMapCameraSnapshot(position, new ImmersiveMapCameraBearingLimits(PI / 12), new ImmersiveMapCameraAngleLimits(0, PI / 6), true);
    const clamped = snapshot.clampedPosition(position);
    expect(clamped.latitudeDegrees).toBeCloseTo(55, 4);
    expect(clamped.longitudeDegrees).toBeCloseTo(37, 4);
    expect(clamped.zoom).toBeCloseTo(3, 4);
    expect(clamped.bearing).toBeCloseTo(PI / 12, 4);
    expect(clamped.pitch).toBeCloseTo(PI / 6, 4);
  });

  test("a snapshot normalizes the bearing before clamping", () => {
    const position = ImmersiveMapCameraPosition.make(0, 0, 1, PI * 1.75, 0);
    const snapshot = new ImmersiveMapCameraSnapshot(position, new ImmersiveMapCameraBearingLimits(PI), new ImmersiveMapCameraAngleLimits(0, PI / 4), false);
    expect(snapshot.clampedPosition(position).bearing).toBeCloseTo(-PI / 4, 4);
  });
});

/** Swift `ImmersiveMapCameraSnapshotResolverTests`. */
describe("ImmersiveMapCameraSnapshotResolver", () => {
  const constraints = (maximumAbsoluteBearing: number | null, minimumPitch: number, maximumPitch: number): CameraConstraints => ({
    bearing: new CameraBearingConstraint(maximumAbsoluteBearing),
    pitch: new CameraPitchConstraint(minimumPitch, maximumPitch),
  });

  test("the resolver exposes the spherical bearing and pitch limits", () => {
    const snapshot = ImmersiveMapCameraSnapshotResolver.resolve(ImmersiveMapCameraPosition.make(0, 0, 1, PI / 2, PI / 2), constraints(PI / 12, 0, PI / 8), true);
    expect(snapshot.bearingLimits.minimum).toBeCloseTo(-PI / 12, 4);
    expect(snapshot.bearingLimits.maximum).toBeCloseTo(PI / 12, 4);
    expect(snapshot.bearingLimits.maximumAbsoluteBearing).toBeCloseTo(PI / 12, 4);
    expect(snapshot.pitchLimits.minimum).toBeCloseTo(0, 4);
    expect(snapshot.pitchLimits.maximum).toBeCloseTo(PI / 8, 4);
    expect(snapshot.isSphericalSurfaceActive).toBe(true);
    expect(snapshot.position.bearing).toBeCloseTo(PI / 12, 4);
    expect(snapshot.position.pitch).toBeCloseTo(PI / 8, 4);
  });

  test("the resolver exposes the flat bearing as a full rotation", () => {
    const snapshot = ImmersiveMapCameraSnapshotResolver.resolve(ImmersiveMapCameraPosition.make(0, 0, 8, -PI / 2, PI / 5), constraints(null, 0, PI / 3), false);
    expect(snapshot.bearingLimits.minimum).toBeCloseTo(-PI, 4);
    expect(snapshot.bearingLimits.maximum).toBeCloseTo(PI, 4);
    expect(snapshot.bearingLimits.maximumAbsoluteBearing).toBeCloseTo(PI, 4);
    expect(snapshot.pitchLimits.maximum).toBeCloseTo(PI / 3, 4);
    expect(snapshot.isSphericalSurfaceActive).toBe(false);
    expect(snapshot.position.bearing).toBeCloseTo(-PI / 2, 4);
    expect(snapshot.position.pitch).toBeCloseTo(PI / 5, 4);
  });

  test("the resolver exposes the pitch floor and lifts the position", () => {
    // The snapshot is what a custom control panel sizes its sliders from, so
    // a configured floor must be visible there and the reported position must
    // already sit on it.
    const snapshot = ImmersiveMapCameraSnapshotResolver.resolve(ImmersiveMapCameraPosition.make(0, 0, 8, 0, 0), constraints(null, 0.3, 0.9), false);
    expect(snapshot.pitchLimits.minimum).toBeCloseTo(0.3, 4);
    expect(snapshot.pitchLimits.maximum).toBeCloseTo(0.9, 4);
    expect(snapshot.position.pitch).toBeCloseTo(0.3, 4);
  });
});
