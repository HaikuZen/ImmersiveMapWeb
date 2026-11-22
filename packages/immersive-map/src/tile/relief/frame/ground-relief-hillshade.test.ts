// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the hillshade's part of the Swift `GroundReliefTests`. The
// style's values drawn at frame time, and so leaving the prepared tiles
// alike, are style/theme.test.ts's.

import { describe, expect, test } from "vitest";
import { zoomCurve } from "../../../configuration/zoom-curve.ts";
import type { Vec3 } from "../../../math/vec.ts";
import { defaultHillshade, hillshade, noHillshade } from "../../../style/theme.ts";
import { GroundReliefHillshade } from "./ground-relief-hillshade.ts";

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

const eye: Vec3 = [0, -30, 40];
const base = { cameraEye: eye, zoom: 14, unitsPerMetre: 0.01, risenShare: 1 };

describe("GroundReliefHillshade", () => {
  test("the slopes are shaded by the scene's light as the relief rises", () => {
    const style = hillshade({ intensity: 0.8 });
    const risen = GroundReliefHillshade.resolve({ ...base, style, lightDirection: [0, 3, 4] });
    expectClose(risen.light[0], 0, 1e-6);
    expectClose(risen.light[1], 0.6, 1e-6);
    expectClose(risen.light[2], 0.8, 1e-6);
    expectClose(risen.light[3], 0.8, 1e-6, "the style's intensity");
    expect(risen.shadowColor).toEqual(style.shadowColor);
    expect(risen.highlightColor).toEqual(style.highlightColor);
    expectClose(GroundReliefHillshade.resolve({ ...base, style, lightDirection: [0, 3, 4], risenShare: 0.5 }).light[3], 0.4, 1e-6, "half risen, half shaded");
    expect(GroundReliefHillshade.resolve({ ...base, style, lightDirection: [1, 0, -0.1] }), "a light under the horizon shades nothing").toEqual(GroundReliefHillshade.none);
    expect(GroundReliefHillshade.resolve({ ...base, style: noHillshade, lightDirection: [0, 3, 4] })).toEqual(GroundReliefHillshade.none);
  });

  test("the shading fades in metres by the zoom", () => {
    const shading = GroundReliefHillshade.resolve({ ...base, style: defaultHillshade, lightDirection: [0, 0, 1] });
    expect(shading.eye.slice(0, 3)).toEqual(eye);
    expectClose(shading.fade[0], 40, 1e-3, "from 4 km, a hundredth of a unit a metre");
    expectClose(shading.fade[1], 1 / 40, 1e-6, "out over 4 km more");
    const zoomedIn = GroundReliefHillshade.resolve({ ...base, style: defaultHillshade, lightDirection: [0, 0, 1], zoom: 15 });
    expectClose(zoomedIn.fade[0], 20, 1e-2, "geometric between the stops: half a zoom up");
    const dragged = GroundReliefHillshade.resolve({
      ...base,
      style: defaultHillshade,
      lightDirection: [0, 0, 1],
      fade: { startMeters: zoomCurve(1000), endMeters: zoomCurve(1500) },
    });
    expectClose(dragged.fade[0], 10, 1e-3);
    expectClose(dragged.fade[1], 1 / 5, 1e-6);
    expect(GroundReliefHillshade.resolve({ ...base, style: defaultHillshade, lightDirection: [0, 0, 1], unitsPerMetre: 0 }), "no rise known, no shading").toEqual(
      GroundReliefHillshade.none,
    );
  });

  test("the panel's amounts replace the style's, clamped", () => {
    const amounts = GroundReliefHillshade.amounts(1.5, -1, 0.3);
    expect(amounts).toEqual({ intensity: 1, shadow: 0, highlight: 0.3 });
    const shaded = GroundReliefHillshade.resolve({ ...base, style: defaultHillshade, lightDirection: [0, 0, 1], amounts });
    expect(shaded.light[3]).toBe(1);
    expect(shaded.shadowColor[3]).toBe(0);
    expect(shaded.highlightColor[3]).toBe(0.3);
    expect(GroundReliefHillshade.amountsOfStyle(defaultHillshade)).toEqual({ intensity: 0.76, shadow: 0.34, highlight: 0.18 });
  });
});
