// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Timing of a traversal of an `ImmersiveMapGeoPath`: a scene model flying
 * along it, or the camera following it. Shared so a model and the camera
 * started together stay in step.
 *
 * - `linear`: constant ground speed over the whole path.
 * - `easeOut`: cubic ease-out, leaves at full speed and settles onto the
 *   destination.
 */
export type ImmersiveMapPathAnimationCurve = "linear" | "easeOut";

/**
 * Fraction of the path travelled after `elapsed` seconds of a `duration`
 * traversal, clamped to `0...1`. The single definition, so a model and a
 * camera started together sit at the same point of the path.
 */
export function pathAnimationFraction(curve: ImmersiveMapPathAnimationCurve, elapsed: number, duration: number): number {
  if (!(duration > 0)) {
    return 1;
  }
  const raw = Math.min(Math.max(elapsed / duration, 0), 1);
  switch (curve) {
    case "linear":
      return raw;
    case "easeOut": {
      const inverse = 1 - raw;
      return 1 - inverse * inverse * inverse;
    }
  }
}
