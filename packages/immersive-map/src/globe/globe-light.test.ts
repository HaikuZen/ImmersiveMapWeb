// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeLightTests.testTheLightIsTheGlobesAlone` (the
// defaults are pinned by immersive-map-settings-defaults.test.ts, the sun by
// globe-sun-direction.test.ts).

import { describe, expect, test } from "vitest";
import { globeLightSettings } from "../configuration/scene-settings.ts";
import { GlobeLight } from "./globe-light.ts";

describe("GlobeLight", () => {
  const settings = globeLightSettings({ strength: { 2: 0.8, 6: 0.2 } });
  const direction = [-0.4, -0.6, 1.0] as const;

  test("the resting globe is lit by the normalized light at the curve's strength", () => {
    const resting = GlobeLight.resolve(settings, direction, "spherical", 0, 2);
    expect(resting.lightAndStrength[3]).toBeCloseTo(0.8, 6);
    expect(Math.hypot(...resting.lightAndStrength.slice(0, 3))).toBeCloseTo(1, 6);
    expect(resting.nightColorAndSoftness[3]).toBe(0.25);
    expect(GlobeLight.resolve(settings, direction, "spherical", 0, 4).lightAndStrength[3]).toBeCloseTo(0.5, 6);
  });

  test("the plane and the unrolled globe are unlit", () => {
    expect(GlobeLight.resolve(settings, direction, "flat", 1, 2).lightAndStrength[3]).toBe(0);
    expect(GlobeLight.resolve(settings, direction, "spherical", 1, 2).lightAndStrength[3]).toBe(0);
  });

  test("the light fades out over the start of the morph", () => {
    expect(GlobeLight.morphFade(0, "spherical")).toBe(1);
    expect(GlobeLight.morphFade(GlobeLight.morphFadeOutEnd / 2, "spherical")).toBeCloseTo(0.5, 6);
    expect(GlobeLight.morphFade(GlobeLight.morphFadeOutEnd, "spherical")).toBe(0);
    expect(GlobeLight.morphFade(0, "flat")).toBe(0);
  });

  test("the light off leaves the surface as it is", () => {
    const off = globeLightSettings({ ...settings, isEnabled: false });
    expect(GlobeLight.resolve(off, direction, "spherical", 0, 2).lightAndStrength[3]).toBe(0);
    expect(GlobeLight.disabled.lightAndStrength[3]).toBe(0);
  });
});
