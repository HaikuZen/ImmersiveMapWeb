// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `StarfieldStarCountTests` and
// `StarfieldTransitionFadeTests.testStarfieldStarsDoNotFadeDuringGlobeTransition`.

import { describe, expect, test } from "vitest";
import { defaultStarfieldSettings, starfieldSettings } from "../configuration/scene-settings.ts";
import starfieldSource from "./shaders/starfield-stars.wgsl?raw";
import { StarfieldModel } from "./starfield-model.ts";

describe("StarfieldModel", () => {
  test("no stars for a zero or negative count", () => {
    expect(StarfieldModel.makeStars(starfieldSettings({ starCount: 0 }))).toEqual([]);
    expect(StarfieldModel.makeStars(starfieldSettings({ starCount: -5 }))).toEqual([]);
  });

  test("small counts produce exactly the stars requested", () => {
    for (let starCount = 1; starCount <= 24; starCount++) {
      expect(StarfieldModel.makeStars(starfieldSettings({ starCount })).length).toBe(starCount);
    }
  });

  test("the default count produces exactly the stars requested", () => {
    expect(StarfieldModel.makeStars(defaultStarfieldSettings).length).toBe(defaultStarfieldSettings.starCount);
  });

  test("the model is deterministic and its stars are unit directions in their ranges", () => {
    const config = starfieldSettings({ starCount: 300 });
    const stars = StarfieldModel.makeStars(config);
    expect(StarfieldModel.makeStars(config)).toEqual(stars);
    for (const star of stars) {
      expect(Math.hypot(...star.position)).toBeCloseTo(1, 5);
      expect(star.size).toBeGreaterThanOrEqual(config.sizeMin);
      expect(star.size).toBeLessThanOrEqual(config.sizeMax + 1e-6);
      expect(star.temperature).toBeGreaterThanOrEqual(0);
      expect(star.temperature).toBeLessThanOrEqual(1);
      expect(star.twinklePhase).toBeLessThanOrEqual(Math.PI * 2 + 1e-6);
    }
  });

  test("the vertex data covers every star, eight floats each", () => {
    const stars = StarfieldModel.makeStars(starfieldSettings({ starCount: 7 }));
    expect(StarfieldModel.vertexData(stars).length).toBe(7 * 8);
    expect(StarfieldModel.vertexData([]).length).toBe(0);
  });

  test("the stars keep their full strength through the unroll", () => {
    expect(starfieldSource).not.toContain("transitionAlpha");
    expect(starfieldSource).not.toContain("in.transition");
    expect(starfieldSource).toContain("let alpha = saturate(core * 0.95 + halo * 0.55 + crossGlow) * intensity;");
  });
});
