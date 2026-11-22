// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The one-thumb tilt zone works in an inverted control value: 0 is the full
 * tilt (the pitch ceiling), and the value grows as the camera levels off, so
 * the reachable span is the distance from the ceiling down to the floor.
 */
export const PitchControlMath = {
  reachablePitchSpan(minimumPitch: number, maximumPitch: number): number {
    const ceiling = Math.max(maximumPitch, 0);
    const floor = Math.min(Math.max(minimumPitch, 0), ceiling);
    return ceiling - floor;
  },

  clampedControlValue(value: number, minimumPitch: number, maximumPitch: number): number {
    return Math.min(Math.max(0, value), PitchControlMath.reachablePitchSpan(minimumPitch, maximumPitch));
  },

  actualPitch(controlValue: number, minimumPitch: number, maximumPitch: number): number {
    return Math.max(maximumPitch, 0) - PitchControlMath.clampedControlValue(controlValue, minimumPitch, maximumPitch);
  },

  controlValue(actualPitch: number, minimumPitch: number, maximumPitch: number): number {
    return PitchControlMath.clampedControlValue(Math.max(maximumPitch, 0) - actualPitch, minimumPitch, maximumPitch);
  },

  controlValueDelta(translationY: number, interactionHeight: number, minimumPitch: number, maximumPitch: number): number {
    const span = PitchControlMath.reachablePitchSpan(minimumPitch, maximumPitch);
    if (!(interactionHeight > 0) || !(span > 0)) {
      return 0;
    }
    return -(translationY / interactionHeight) * span;
  },
} as const;
