// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Stateless math for time-normalized smoothing of camera pitch toward a
 * target value. The gap between the current and target pitch decays
 * exponentially by half-life, so the per-frame step depends on elapsed time
 * rather than the uneven rate of touch events.
 */
export const CameraPitchFollowMath = {
  /** Maximum dt between ticks (guards against a jump after a pause or a background tab). */
  maximumDeltaTime: 0.05,

  /** Threshold in radians below which pitch is considered to have reached the target and follow is released. */
  snapThreshold: 0.0003,

  /**
   * No-progress threshold: if the actual pitch did not move between frames
   * (hit a clamp or ceiling) while the target is still far away, follow must
   * stop rather than spin forever.
   */
  progressThreshold: 0.00002,

  clampedDeltaTime(deltaTime: number): number {
    if (!Number.isFinite(deltaTime)) {
      return 0;
    }
    return Math.min(Math.max(0, deltaTime), CameraPitchFollowMath.maximumDeltaTime);
  },

  /** New pitch for the frame: the remaining gap to the target is multiplied by the half-life factor. */
  steppedPitch(current: number, target: number, deltaTime: number, halfLife: number): number {
    const sanitizedHalfLife = Math.max(0.001, Number.isFinite(halfLife) ? halfLife : 0.001);
    const factor = Math.exp((-Math.log(2.0) * deltaTime) / sanitizedHalfLife);
    return target - (target - current) * factor;
  },

  shouldSnap(current: number, target: number): boolean {
    return Math.abs(target - current) <= CameraPitchFollowMath.snapThreshold;
  },

  /**
   * True if the actual pitch is stuck (hit the clamp at the ceiling): no
   * progress between frames but the target is not reached. Needed so follow
   * does not keep the frames coming forever.
   */
  isStalled(current: number, previous: number, target: number): boolean {
    return Math.abs(current - previous) <= CameraPitchFollowMath.progressThreshold && Math.abs(target - current) > CameraPitchFollowMath.snapThreshold;
  },
} as const;
