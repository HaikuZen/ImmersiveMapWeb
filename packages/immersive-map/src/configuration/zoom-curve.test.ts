// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `ImmersiveMapZoomCurveTests` (GroundFogTests.swift).

import { describe, expect, test } from "vitest";
import { zoomCurve, zoomCurveConstantValue, zoomCurveStops, zoomCurveValue } from "./zoom-curve.ts";

describe("ImmersiveMapZoomCurve", () => {
  test("a single value is the same at every zoom", () => {
    const curve = zoomCurve(0.3);
    expect(zoomCurveValue(curve, 0)).toBe(0.3);
    expect(zoomCurveValue(curve, 22)).toBe(0.3);
    expect(zoomCurveConstantValue(curve)).toBe(0.3);
  });

  /** The ends hold past the first and the last stop, and between two stops the value eases in and out on a smoothstep. */
  test("stops blend smoothly", () => {
    const curve = zoomCurve({ 16: 1, 12: 0 });
    expect(zoomCurveStops(curve).map((stop) => stop.zoom)).toEqual([12, 16]);
    expect(zoomCurveConstantValue(curve)).toBeNull();
    expect(zoomCurveValue(curve, 10)).toBe(0);
    expect(zoomCurveValue(curve, 12)).toBe(0);
    expect(zoomCurveValue(curve, 14)).toBeCloseTo(0.5, 6);
    expect(zoomCurveValue(curve, 13)).toBeCloseTo(0.15625, 6);
    expect(zoomCurveValue(curve, 16)).toBe(1);
    expect(zoomCurveValue(curve, 20)).toBe(1);
  });

  test("each segment blends between its own stops", () => {
    const curve = zoomCurve({ 13: 4, 14: 1, 15: 0.15 });
    expect(zoomCurveValue(curve, 13.5)).toBeCloseTo(2.5, 6);
    expect(zoomCurveValue(curve, 14)).toBe(1);
    expect(zoomCurveValue(curve, 14.5)).toBeCloseTo(0.575, 6);
  });

  /** Geometrically the value changes by the same ratio for every step of zoom, and a stop not above zero falls back to the smoothstep. */
  test("geometric stops keep a ratio per zoom", () => {
    const curve = zoomCurve({ 12: 3200, 16: 200 });
    expect(zoomCurveValue(curve, 13, "geometric")).toBeCloseTo(1600, 2);
    expect(zoomCurveValue(curve, 14, "geometric")).toBeCloseTo(800, 2);
    expect(zoomCurveValue(curve, 15, "geometric")).toBeCloseTo(400, 2);
    const withZero = zoomCurve({ 12: 0, 16: 1 });
    expect(zoomCurveValue(withZero, 14, "geometric")).toBeCloseTo(0.5, 6);
  });

  test("a curve needs a stop, and its zooms are written canonically", () => {
    expect(() => zoomCurve({})).toThrow(RangeError);
    expect(zoomCurve({ 15.5: 1, 14: 2 })).toEqual({ 14: 2, 15.5: 1 });
    expect(zoomCurve(2)).toEqual({ 0: 2 });
  });
});
