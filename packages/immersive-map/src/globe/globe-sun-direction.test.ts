// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeLightTests.testTheSunIsFixedToTheEarth`.

import { describe, expect, test } from "vitest";
import { globeLightSettings } from "../configuration/scene-settings.ts";
import { GlobeSunDirection } from "./globe-sun-direction.ts";

describe("GlobeSunDirection", () => {
  const settings = globeLightSettings({ subsolarLatitudeDegrees: 23.4, subsolarLongitudeDegrees: 40 });

  test("the earth frame: y the pole, z toward longitude 0, x toward 90 east", () => {
    expect(Math.hypot(...GlobeSunDirection.earthDirection(23.4, 40))).toBeCloseTo(1, 6);
    expect(GlobeSunDirection.earthDirection(90, 0)[1]).toBeCloseTo(1, 6);
    expect(GlobeSunDirection.earthDirection(0, 0)[2]).toBeCloseTo(1, 6);
    expect(GlobeSunDirection.earthDirection(0, 90)[0]).toBeCloseTo(1, 6);
  });

  test("the sun stands over its point whichever way the globe is turned", () => {
    const subsolar = GlobeSunDirection.earthDirection(23.4, 40);
    for (const [panX, panY] of [
      [0, 0],
      [0.3, -0.2],
      [-0.8, 0.5],
    ] as const) {
      const globe = { panX, panY, radius: 0.3, transition: 0 };
      const sun = GlobeSunDirection.sunWorldDirection(settings, globe);
      // The sphere's world normal at the subsolar point: the row-vector
      // rotation the globe's vertices take, `v * M`.
      const r = GlobeSunDirection.globeRotationMatrix(globe);
      const normal = [0, 1, 2].map((j) => r[j * 4]! * subsolar[0] + r[j * 4 + 1]! * subsolar[1] + r[j * 4 + 2]! * subsolar[2]);
      const length = Math.hypot(...normal);
      const dot = (sun[0] * normal[0]! + sun[1] * normal[1]! + sun[2] * normal[2]!) / length;
      expect(dot).toBeCloseTo(1, 5);
    }
    const east = GlobeSunDirection.sunWorldDirection(settings, { panX: 0, panY: 0, radius: 1, transition: 0 });
    const turned = GlobeSunDirection.sunWorldDirection(settings, { panX: 0.5, panY: 0, radius: 1, transition: 0 });
    expect(turned).not.toEqual(east);
  });
});
