// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlaySunDialTests` and the sun angle tests
// of `DebugOverlayShadowGroupTests`.

import { describe, expect, test } from "vitest";
import { defaultSceneLightSettings } from "../../configuration/scene-settings.ts";
import type { Vector3 } from "../../configuration/color.ts";
import { ShadowFrameStateResolver } from "../../shadows/shadow-frame-state-resolver.ts";
import { DebugOverlayShadowSettingsPlanner } from "./debug-overlay-shadow-settings-planner.ts";
import { DebugOverlaySunAngles, DebugOverlaySunDial } from "./debug-overlay-sun-angles.ts";

const elevationRange = DebugOverlayShadowSettingsPlanner.elevationRange;

describe("DebugOverlaySunAngles", () => {
  test("the cardinal directions", () => {
    const north = DebugOverlaySunAngles.direction(0, 0);
    expect(north[0]).toBeCloseTo(0, 6);
    expect(north[1]).toBeCloseTo(1, 6);
    expect(north[2]).toBeCloseTo(0, 6);
    const east = DebugOverlaySunAngles.direction(90, 0);
    expect(east[0]).toBeCloseTo(1, 6);
    expect(east[1]).toBeCloseTo(0, 6);
    expect(DebugOverlaySunAngles.direction(123, 90)[2]).toBeCloseTo(1, 6);
  });

  test("the angles round-trip through the direction", () => {
    for (let azimuth = 0; azimuth <= 350; azimuth += 17) {
      for (let elevation = 5; elevation <= 85; elevation += 11) {
        const angles = DebugOverlaySunAngles.angles(DebugOverlaySunAngles.direction(azimuth, elevation));
        expect(angles.azimuthDegrees).toBeCloseTo(azimuth, 3);
        expect(angles.elevationDegrees).toBeCloseTo(elevation, 3);
      }
    }
  });

  /** Every shadow of a map with the defaults is aimed by a sun in the south-west. */
  test("the default light reads as a south-western sun", () => {
    const angles = DebugOverlaySunAngles.angles(defaultSceneLightSettings.direction);
    expect(angles.azimuthDegrees).toBeGreaterThan(180);
    expect(angles.azimuthDegrees).toBeLessThan(270);
    expect(Math.abs(angles.elevationDegrees - 54.2)).toBeLessThanOrEqual(0.5);
  });

  test("a degenerate direction reads as overhead, not as a NaN", () => {
    expect(DebugOverlaySunAngles.angles([0, 0, 0])).toEqual({ azimuthDegrees: 0, elevationDegrees: 90 });
  });

  test("an unnormalized direction reads as its normal does", () => {
    const direction: Vector3 = [-0.4, -0.6, 1];
    const scaled: Vector3 = [-0.4 * 37, -0.6 * 37, 37];
    const angles = DebugOverlaySunAngles.angles(direction);
    const scaledAngles = DebugOverlaySunAngles.angles(scaled);
    expect(angles.azimuthDegrees).toBeCloseTo(scaledAngles.azimuthDegrees, 3);
    expect(angles.elevationDegrees).toBeCloseTo(scaledAngles.elevationDegrees, 3);
  });

  /** A slider whose end silently turns the shadows off reads as a bug rather than as a setting. */
  test("the elevation slider stays above the resolver's cutoff", () => {
    const lowest = DebugOverlaySunAngles.direction(0, elevationRange.lowerBound);
    expect(lowest[2]).toBeGreaterThan(ShadowFrameStateResolver.minimumLightDirectionZ);
  });
});

describe("DebugOverlaySunDial", () => {
  /** The camera turned by a bearing looks the opposite turn round the compass: a bearing of 90° east of north is a view to the west. */
  test("the view is the bearing's opposite turn", () => {
    expect(DebugOverlaySunDial.viewAzimuthDegrees(0)).toBe(0);
    expect(Object.is(DebugOverlaySunDial.viewAzimuthDegrees(0), -0)).toBe(false);
    expect(DebugOverlaySunDial.viewAzimuthDegrees(Math.PI / 2)).toBeCloseTo(270, 9);
    expect(DebugOverlaySunDial.viewAzimuthDegrees(-Math.PI / 2)).toBeCloseTo(90, 9);
  });

  /** Up the disc is the view: a sun ahead stands at the top, the zenith at the centre and the horizon on the rim. */
  test("the disc turns with the view", () => {
    const ahead = DebugOverlaySunDial.point(120, 0, 120);
    expect(ahead.x).toBeCloseTo(0, 9);
    expect(ahead.y).toBeCloseTo(1, 9);
    const right = DebugOverlaySunDial.point(210, 45, 120);
    expect(right.x).toBeCloseTo(0.5, 9);
    expect(right.y).toBeCloseTo(0, 9);
    const zenith = DebugOverlaySunDial.point(0, 90, 0);
    expect(Math.hypot(zenith.x, zenith.y)).toBeCloseTo(0, 9);
  });

  test("a drag reads back the sun it shows and keeps the elevation to the range", () => {
    const point = DebugOverlaySunDial.point(195, 54, 300);
    const angles = DebugOverlaySunDial.angles(point, 300, 0, elevationRange);
    expect(angles.azimuthDegrees).toBeCloseTo(195, 9);
    expect(angles.elevationDegrees).toBeCloseTo(54, 9);
    expect(DebugOverlaySunDial.angles({ x: 0, y: 3 }, 0, 0, elevationRange).elevationDegrees).toBe(elevationRange.lowerBound);
    const atTheCentre = DebugOverlaySunDial.angles({ x: 0, y: 0 }, 0, 77, elevationRange);
    expect(atTheCentre.azimuthDegrees).toBe(77);
    expect(atTheCentre.elevationDegrees).toBe(elevationRange.upperBound);
  });

  test("the side view reads the elevation either side of the ground's point", () => {
    expect(DebugOverlaySunDial.elevation({ x: 1, y: 1 }, elevationRange)).toBeCloseTo(45, 9);
    expect(DebugOverlaySunDial.elevation({ x: -1, y: 1 }, elevationRange)).toBeCloseTo(45, 9);
    expect(DebugOverlaySunDial.elevation({ x: 1, y: -1 }, elevationRange)).toBe(elevationRange.lowerBound);
  });

  /** The views' pixels run y down, the disc's and the side view's points y up, and the two convert both ways. */
  test("the pointer and the pixels convert through the views' geometry", () => {
    const disc = DebugOverlaySunDial.discRect({ x: 0, y: 0, width: 200, height: 200 });
    expect(disc).toEqual({ x: 12, y: 12, width: 176, height: 176 });
    expect(DebugOverlaySunDial.discPoint({ x: 100, y: 12 }, disc)).toEqual({ x: 0, y: 1 });
    expect(DebugOverlaySunDial.discPixel({ x: 0, y: 1 }, disc)).toEqual({ x: 100, y: 12 });
    expect(DebugOverlaySunDial.discPoint({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 0 })).toBeUndefined();

    const side = DebugOverlaySunDial.sideGeometry({ x: 0, y: 0, width: 200, height: 120 });
    expect(side).toEqual({ origin: { x: 52, y: 108 }, radius: 96 });
    const sun = DebugOverlaySunDial.sidePixel(45, side);
    expect(DebugOverlaySunDial.elevation(DebugOverlaySunDial.sidePoint(sun, side), { lowerBound: 0, upperBound: 90 })).toBeCloseTo(45, 9);
  });
});
