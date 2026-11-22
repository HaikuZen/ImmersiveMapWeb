// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `ImmersiveMapLabelOpacityTests` (a label's opacity
// under the frame's factor for its kind, the curves are in style/theme.test.ts)
// and `ImmersiveMapZoomFadeTests` (the smoothstep of the overview fade, the
// one zoom fade the labels read), with the globe's fill colour at the
// handover.

import { describe, expect, test } from "vitest";
import { labelAppearance } from "../../style/theme.ts";
import type { PreparedLabelTextStyle } from "../../tile/store/prepared-labels.ts";
import { colorAtHandover, labelOpacityOf, overviewFadeAlpha } from "./label-text-style.ts";

function style(isPointOfInterest: boolean): PreparedLabelTextStyle {
  return {
    ...labelAppearance({ fillColor: [0, 0, 0], strokeColor: [1, 1, 1], haloEm: 0.1, sizePoints: 12, weight: isPointOfInterest ? "thin" : "bold", opacity: 0.8 }),
    key: 1,
    isPointOfInterest,
    sphereFillColor: null,
    sphereStrokeColor: null,
  };
}

describe("labelOpacityOf", () => {
  test("a POI takes the POIs' factor and every other label the names'", () => {
    const frame = { names: 0.5, pois: 0.25 };
    expect(labelOpacityOf(style(false), frame)).toBeCloseTo(0.4, 6);
    expect(labelOpacityOf(style(true), frame)).toBeCloseTo(0.2, 6);
  });
});

describe("overviewFadeAlpha", () => {
  test("the overview rises from nothing at zoom 0 to full at zoom 1", () => {
    expect(overviewFadeAlpha(-3)).toBe(0);
    expect(overviewFadeAlpha(0)).toBe(0);
    expect(overviewFadeAlpha(0.5)).toBeCloseTo(0.5, 6);
    expect(overviewFadeAlpha(1)).toBe(1);
    expect(overviewFadeAlpha(12)).toBe(1);
  });

  // The curve is a smoothstep, not a ramp: flat at both ends, so a fade
  // starts and settles without a visible kink.
  test("the curve is a smoothstep", () => {
    expect(overviewFadeAlpha(0.25)).toBeCloseTo(0.15625, 6);
    expect(overviewFadeAlpha(0.75)).toBeCloseTo(0.84375, 6);
    expect(overviewFadeAlpha(0.3) + (1 - overviewFadeAlpha(0.3)), "a fade in and its fade out cross-fade to a constant sum").toBeCloseTo(1, 6);
  });
});

describe("colorAtHandover", () => {
  test("the globe's colour at 0, the label's own at 1, mixed between", () => {
    const sphere: [number, number, number] = [1, 0, 0.5];
    const own: [number, number, number] = [0, 1, 0.5];
    expect(colorAtHandover(sphere, own, 0)).toEqual([1, 0, 0.5]);
    expect(colorAtHandover(sphere, own, 1)).toEqual([0, 1, 0.5]);
    expect(colorAtHandover(sphere, own, 0.25)).toEqual([0.75, 0.25, 0.5]);
    expect(colorAtHandover(sphere, own, -1), "held to the unit range").toEqual([1, 0, 0.5]);
    expect(colorAtHandover(sphere, own, 2)).toEqual([0, 1, 0.5]);
  });

  test("a label that states no globe colour wears its own everywhere", () => {
    const own: [number, number, number] = [0.2, 0.3, 0.4];
    expect(colorAtHandover(null, own, 0)).toBe(own);
  });
});
