// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PitchControlMath } from "./pitch-control-math.ts";

/**
 * The one-thumb tilt zone works in an inverted control value: 0 is the pitch
 * ceiling and the largest value is the floor, so a configured `minimumPitch`
 * shortens the reachable span instead of leaving a dead stretch of the zone.
 */
describe("PitchControlMath", () => {
  test("the control value spans the ceiling down to the floor", () => {
    expect(PitchControlMath.actualPitch(0, 0.3, 1.2)).toBeCloseTo(1.2, 4);
    expect(PitchControlMath.actualPitch(10, 0.3, 1.2)).toBeCloseTo(0.3, 4);
  });

  test("the control value round-trips the pitch", () => {
    const value = PitchControlMath.controlValue(0.7, 0.3, 1.2);
    expect(PitchControlMath.actualPitch(value, 0.3, 1.2)).toBeCloseTo(0.7, 4);
  });

  test("the drag delta scales with the reachable span", () => {
    // A full-height drag traverses exactly the reachable span, so the zone
    // keeps its feel whatever the configured range is.
    expect(PitchControlMath.controlValueDelta(-100, 100, 0.3, 1.2)).toBeCloseTo(0.9, 4);
  });

  test("a collapsed range produces no motion", () => {
    expect(PitchControlMath.controlValueDelta(-100, 100, 1.2, 1.2)).toBe(0);
  });
});
