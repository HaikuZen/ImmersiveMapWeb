// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { CameraControlMath } from "./camera-control-math.ts";
import { ImmersiveMapCameraAngleLimits, ImmersiveMapCameraBearingLimits, ImmersiveMapCameraSnapshot } from "./immersive-map-camera-snapshot.ts";

const PI = Math.PI;

function snapshot(maximumAbsoluteBearing: number, minimumPitch = 0, maximumPitch = PI / 3): ImmersiveMapCameraSnapshot {
  return new ImmersiveMapCameraSnapshot(
    ImmersiveMapCameraPosition.make(48, 11, 12, 0, 0),
    new ImmersiveMapCameraBearingLimits(maximumAbsoluteBearing),
    new ImmersiveMapCameraAngleLimits(minimumPitch, maximumPitch),
    false,
  );
}

describe("CameraControlMath angles", () => {
  test("normalizes degrees by whole turns", () => {
    expect(CameraControlMath.normalizedDegrees(0)).toBe(0);
    expect(CameraControlMath.normalizedDegrees(180)).toBe(180);
    expect(CameraControlMath.normalizedDegrees(190)).toBe(-170);
    expect(CameraControlMath.normalizedDegrees(-190)).toBe(170);
    expect(CameraControlMath.normalizedDegrees(720 + 30)).toBe(30);
    expect(CameraControlMath.normalizedDegrees(-720 - 30)).toBe(-30);
  });

  test("converts radians to normalized degrees and back", () => {
    expect(CameraControlMath.degreesFromRadians(PI / 2)).toBeCloseTo(90, 9);
    expect(CameraControlMath.degreesFromRadians((3 * PI) / 2)).toBeCloseTo(-90, 9);
    expect(CameraControlMath.radiansFromDegrees(90)).toBeCloseTo(PI / 2, 9);
    expect(CameraControlMath.radiansFromDegrees(270)).toBeCloseTo(-PI / 2, 9);
  });

  test("formats the readout as whole degrees rounded half away from zero", () => {
    expect(CameraControlMath.formattedDegrees(14.4)).toBe("14 deg");
    expect(CameraControlMath.formattedDegrees(14.5)).toBe("15 deg");
    expect(CameraControlMath.formattedDegrees(-14.5)).toBe("-15 deg");
    expect(CameraControlMath.formattedDegrees(-0.2)).toBe("0 deg");
    expect(CameraControlMath.formattedDegrees(0)).toBe("0 deg");
  });

  test("clamps degrees into a range", () => {
    const range = { lowerBound: -10, upperBound: 20 };
    expect(CameraControlMath.clampedDegrees(-30, range)).toBe(-10);
    expect(CameraControlMath.clampedDegrees(5, range)).toBe(5);
    expect(CameraControlMath.clampedDegrees(30, range)).toBe(20);
  });
});

describe("CameraControlMath ranges", () => {
  test("a full circle of bearing spans -180...179", () => {
    expect(CameraControlMath.bearingRangeDegrees(snapshot(PI))).toEqual({ lowerBound: -180, upperBound: 179 });
  });

  test("a capped bearing spans the cap on both sides of north", () => {
    const range = CameraControlMath.bearingRangeDegrees(snapshot(PI / 4));
    expect(range.lowerBound).toBeCloseTo(-45, 9);
    expect(range.upperBound).toBeCloseTo(45, 9);
  });

  test("the pitch range follows the snapshot's pitch limits", () => {
    const range = CameraControlMath.pitchRangeDegrees(snapshot(PI, PI / 18, PI / 3));
    expect(range.lowerBound).toBeCloseTo(10, 9);
    expect(range.upperBound).toBeCloseTo(60, 9);
  });
});

describe("CameraControlMath bearing cap", () => {
  test("a +15 press at the cap stays at the cap", () => {
    const range = { lowerBound: -170, upperBound: 170 };
    // 185 normalizes to -175, which a plain clamp would send to -170, the opposite edge.
    expect(CameraControlMath.clampedBearingDegrees(170 + 15, range)).toBe(170);
    expect(CameraControlMath.clampedBearingDegrees(-170 - 15, range)).toBe(-170);
  });

  test("a press past a narrow cap saturates at it", () => {
    const range = { lowerBound: -45, upperBound: 45 };
    expect(CameraControlMath.clampedBearingDegrees(45 + 15, range)).toBe(45);
    expect(CameraControlMath.clampedBearingDegrees(-45 - 15, range)).toBe(-45);
  });

  test("a value inside the range is normalized", () => {
    const range = { lowerBound: -45, upperBound: 45 };
    expect(CameraControlMath.clampedBearingDegrees(30, range)).toBe(30);
    expect(CameraControlMath.clampedBearingDegrees(360 + 30, range)).toBe(30);
  });

  test("a full circle wraps across the back of the compass", () => {
    const range = { lowerBound: -180, upperBound: 179 };
    expect(CameraControlMath.clampedBearingDegrees(175 + 15, range)).toBe(-170);
    expect(CameraControlMath.clampedBearingDegrees(-175 - 15, range)).toBe(170);
  });
});

describe("CameraControlMath slider", () => {
  const range = { lowerBound: -180, upperBound: 179 };

  test("progress runs from 0 at the lower bound to 1 at the upper one", () => {
    expect(CameraControlMath.sliderProgress(-180, range)).toBe(0);
    expect(CameraControlMath.sliderProgress(179, range)).toBe(1);
    expect(CameraControlMath.sliderProgress(-0.5, range)).toBeCloseTo(0.5, 9);
  });

  test("progress clamps a value outside the range and is 0 for an empty range", () => {
    expect(CameraControlMath.sliderProgress(500, range)).toBe(1);
    expect(CameraControlMath.sliderProgress(-500, range)).toBe(0);
    expect(CameraControlMath.sliderProgress(5, { lowerBound: 5, upperBound: 5 })).toBe(0);
  });

  test("the value under the pointer leaves half a thumb at either end", () => {
    const width = 22 + 100;
    expect(CameraControlMath.sliderValue(11, width, range)).toBe(-180);
    expect(CameraControlMath.sliderValue(0, width, range)).toBe(-180);
    expect(CameraControlMath.sliderValue(111, width, range)).toBe(179);
    expect(CameraControlMath.sliderValue(500, width, range)).toBe(179);
    expect(CameraControlMath.sliderValue(61, width, range)).toBeCloseTo(-0.5, 9);
  });

  test("the value and the progress agree", () => {
    const pitchRange = { lowerBound: 0, upperBound: 85 };
    const width = 220;
    const value = CameraControlMath.sliderValue(80, width, pitchRange);
    const progress = CameraControlMath.sliderProgress(value, pitchRange);
    expect(CameraControlMath.sliderThumbSize / 2 + (width - CameraControlMath.sliderThumbSize) * progress).toBeCloseTo(80, 9);
  });

  test("a slider narrower than its thumb keeps a one pixel track", () => {
    expect(CameraControlMath.sliderValue(12, 10, { lowerBound: 0, upperBound: 10 })).toBe(10);
  });
});

describe("CameraControlMath position", () => {
  test("replaces the angles and keeps the rest", () => {
    const position = ImmersiveMapCameraPosition.make(48, 11, 12, 0.1, 0.2);
    const next = CameraControlMath.positionWithCameraAngles(position, 270, 30);
    expect(next.latitudeDegrees).toBe(48);
    expect(next.longitudeDegrees).toBe(11);
    expect(next.zoom).toBe(12);
    expect(next.bearing).toBeCloseTo(-PI / 2, 9);
    expect(next.pitch).toBeCloseTo(PI / 6, 9);
  });

  test("the snapshot clamps the new angles into its limits", () => {
    const capped = snapshot(PI / 4, 0, PI / 3);
    const next = capped.clampedPosition(CameraControlMath.positionWithCameraAngles(capped.position, 90, 80));
    expect(next.bearing).toBeCloseTo(PI / 4, 9);
    expect(next.pitch).toBeCloseTo(PI / 3, 9);
  });
});
