// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultCameraSettings } from "../configuration/camera-settings.ts";
import { TwoFingerTiltGestureMath } from "./two-finger-tilt-gesture-math.ts";

/**
 * The two-finger tilt shares its touches with the pinch and rotation
 * gestures, so its math has to commit to tilting only for the drag that
 * means it: fingers side by side, moving together mostly vertically.
 */
describe("TwoFingerTiltGestureMath", () => {
  // Touch layout

  test("fingers side by side may tilt", () => {
    expect(TwoFingerTiltGestureMath.touchLayoutAllowsTilt([100, 300], [220, 310])).toBe(true);
  });

  test("fingers stacked vertically never tilt", () => {
    expect(TwoFingerTiltGestureMath.touchLayoutAllowsTilt([160, 200], [170, 420])).toBe(false);
  });

  test("a diagonal finger layout still tilts", () => {
    expect(TwoFingerTiltGestureMath.touchLayoutAllowsTilt([100, 100], [200, 200])).toBe(true);
  });

  // Intent

  test("a short movement stays undecided", () => {
    expect(TwoFingerTiltGestureMath.intent([1, -3])).toBe("undecided");
  });

  test("a mostly vertical movement is a tilt", () => {
    expect(TwoFingerTiltGestureMath.intent([2, -14])).toBe("tilt");
    expect(TwoFingerTiltGestureMath.intent([-1, 12])).toBe("tilt");
  });

  test("a mostly horizontal movement is left to other gestures", () => {
    expect(TwoFingerTiltGestureMath.intent([15, 4])).toBe("other");
  });

  test("a purely diagonal movement is not a tilt", () => {
    expect(TwoFingerTiltGestureMath.intent([10, -10])).toBe("other");
  });

  // Pitch delta

  test("dragging down tilts further", () => {
    expect(TwoFingerTiltGestureMath.pitchDelta(100, 800, 1.2, 1.0)).toBeCloseTo(0.15, 4);
  });

  test("dragging up levels off", () => {
    expect(TwoFingerTiltGestureMath.pitchDelta(-200, 800, 1.2, 1.0)).toBeCloseTo(-0.3, 4);
  });

  test("a full-height drag sweeps the full ceiling at unit sensitivity", () => {
    expect(TwoFingerTiltGestureMath.pitchDelta(800, 800, 1.2, 1.0)).toBeCloseTo(1.2, 4);
  });

  test("the sensitivity multiplies the delta", () => {
    expect(TwoFingerTiltGestureMath.pitchDelta(100, 800, 1.2, 2.0)).toBeCloseTo(0.3, 4);
  });

  test("a negative sensitivity inverts the direction", () => {
    expect(TwoFingerTiltGestureMath.pitchDelta(-100, 800, 1.2, -2.0)).toBeCloseTo(0.3, 4);
  });

  test("the default settings tilt at double speed", () => {
    expect(defaultCameraSettings.tiltGestureSensitivity).toBeCloseTo(2.0, 4);
  });

  test("a zero-height view produces no delta", () => {
    expect(TwoFingerTiltGestureMath.pitchDelta(-100, 0, 1.2, 2.0)).toBe(0);
  });
});
