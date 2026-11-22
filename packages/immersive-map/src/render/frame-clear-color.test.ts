// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `StarfieldTransitionFadeTests.testSpaceClearColorBlendsIntoTheMapColorOverTheAirHandover`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { defaultTheme, themeBaseColors } from "../style/theme.ts";
import { frameClearColor } from "./frame-clear-color.ts";

describe("frameClearColor", () => {
  const settings = ImmersiveMapSettings.default;
  const presentation = settings.presentation;
  const space = settings.scene.space;
  const map = themeBaseColors(defaultTheme).map;

  test("space up to the air handover, the map's colour from its end on, blended between", () => {
    for (const transition of [0, 0.5, presentation.airHandoverStart]) {
      const color = frameClearColor(transition, presentation, space, map);
      expect(color.r).toBeCloseTo(space.clearColor[0], 9);
      expect(color.g).toBeCloseTo(space.clearColor[1], 9);
      expect(color.b).toBeCloseTo(space.clearColor[2], 9);
    }
    const midway = frameClearColor((presentation.airHandoverStart + presentation.airHandoverEnd) / 2, presentation, space, map);
    expect(midway.r).toBeCloseTo((space.clearColor[0] + map[0]) / 2, 6);
    expect(midway.g).toBeCloseTo((space.clearColor[1] + map[1]) / 2, 6);
    expect(midway.b).toBeCloseTo((space.clearColor[2] + map[2]) / 2, 6);
    for (const transition of [presentation.airHandoverEnd, 0.95, 0.999, 1]) {
      const color = frameClearColor(transition, presentation, space, map);
      expect(color.r).toBeCloseTo(map[0], 9);
      expect(color.g).toBeCloseTo(map[1], 9);
      expect(color.b).toBeCloseTo(map[2], 9);
    }
  });

  test("transparent space clears to nothing and reaches the map's colour premultiplied", () => {
    const transparent = { ...space, isTransparent: true };
    expect(frameClearColor(0, presentation, transparent, map)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    const translucent = [0.5, 0.25, 1, 0.5] as const;
    const flat = frameClearColor(1, presentation, transparent, translucent);
    expect(flat.r).toBeCloseTo(0.25, 9);
    expect(flat.g).toBeCloseTo(0.125, 9);
    expect(flat.b).toBeCloseTo(0.5, 9);
    expect(flat.a).toBeCloseTo(0.5, 9);
  });
});
