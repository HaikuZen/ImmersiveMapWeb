// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "./vec.ts";

/**
 * What an accumulated two-finger translation has revealed so far.
 *
 * - `undecided`: too little movement to tell a tilt from a pinch or rotation.
 * - `tilt`: mostly vertical movement, the drag is a tilt.
 * - `other`: mostly horizontal movement, leave the drag to the other gestures.
 */
export type TwoFingerTiltIntent = "undecided" | "tilt" | "other";

const activationDistance = 8;

/**
 * Decides when a two-finger drag on the map is a tilt and how far it tilts.
 * A tilt is a drag with the fingers roughly side by side moving mostly
 * vertically. A pinch or a rotation moves the fingers against each other,
 * so their average translation stays short and never crosses the activation
 * distance. The gesture layer feeds these decisions with the touch locations
 * and accumulated translation and applies the resulting pitch delta through
 * the camera runtime.
 */
export const TwoFingerTiltGestureMath = {
  /** How far the fingers travel together before the drag commits to being a tilt or not, in CSS pixels. */
  activationDistance,

  /**
   * Two fingers roughly side by side may tilt. Fingers stacked closer to
   * vertically than horizontally are a pinch or rotation posture, and a
   * vertical drag from it would zoom or spin in every other map, so it never
   * tilts here either.
   */
  touchLayoutAllowsTilt(first: Vec2, second: Vec2): boolean {
    return Math.abs(second[1] - first[1]) <= Math.abs(second[0] - first[0]);
  },

  /**
   * Classifies the translation accumulated since the gesture began. The
   * answer is only meaningful until the first non-`undecided` result. After
   * that the caller sticks with its decision for the rest of the gesture
   * rather than re-litigating it on every finger wobble.
   */
  intent(translation: Vec2, distance: number = activationDistance): TwoFingerTiltIntent {
    if (!(Math.abs(translation[0]) + Math.abs(translation[1]) >= distance)) {
      return "undecided";
    }
    return Math.abs(translation[1]) > Math.abs(translation[0]) ? "tilt" : "other";
  },

  /**
   * Dragging across the full view height sweeps the full pitch ceiling
   * `sensitivity` times over: down tilts further, up levels off.
   * `CameraSettings.tiltGestureSensitivity` feeds the multiplier, and its
   * sign picks the direction, so a negative value inverts the drag (up tilts
   * further).
   */
  pitchDelta(translationY: number, viewHeight: number, maximumPitch: number, sensitivity: number): number {
    if (!(viewHeight > 0)) {
      return 0;
    }
    return (translationY / viewHeight) * Math.max(maximumPitch, 0) * sensitivity;
  },
} as const;
