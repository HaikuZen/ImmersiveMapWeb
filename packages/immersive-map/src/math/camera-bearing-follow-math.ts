// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Stateless math for time-normalized smoothing of camera bearing toward a
 * target value. Unlike pitch, bearing is cyclic: the settle follows the
 * shortest angular path (through 180 degrees) unless a bearing cap forbids
 * that path, and the gap decays exponentially by half-life, so the per-frame
 * step depends on time rather than on the uneven event rate of the slider or
 * gesture.
 */
export const CameraBearingFollowMath = {
  maximumDeltaTime: 0.05,
  snapThreshold: 0.0003,
  progressThreshold: 0.00002,

  clampedDeltaTime(deltaTime: number): number {
    if (!Number.isFinite(deltaTime)) {
      return 0;
    }
    return Math.min(Math.max(0, deltaTime), CameraBearingFollowMath.maximumDeltaTime);
  },

  /** Shortest angular difference target - current, normalized to [-pi, pi]. */
  shortestDelta(current: number, target: number): number {
    const twoPi = Math.PI * 2;
    let delta = (target - current) % twoPi;
    if (delta > Math.PI) {
      delta -= twoPi;
    } else if (delta < -Math.PI) {
      delta += twoPi;
    }
    return delta;
  },

  /**
   * The angular gap the follow eases across. The shortest path is right for
   * an unbounded compass, but under a bearing cap wider than a quarter turn
   * the shortest path between two legal bearings can run behind the compass
   * through the forbidden arc: each eased step is then clamped back to one
   * cap edge and the follow stalls there instead of arriving. Between two
   * bearings inside the cap the plain difference of the normalized angles is
   * the monotone in-window path, so under a cap that is the one to ease.
   */
  followDelta(current: number, target: number, maximumAbsoluteBearing: number): number {
    if (!(maximumAbsoluteBearing < Math.PI)) {
      return CameraBearingFollowMath.shortestDelta(current, target);
    }
    return CameraBearingFollowMath.normalized(target) - CameraBearingFollowMath.normalized(current);
  },

  /** Normalizes an angle to (-pi, pi]. */
  normalized(bearing: number): number {
    const twoPi = Math.PI * 2;
    let value = bearing % twoPi;
    if (value > Math.PI) {
      value -= twoPi;
    } else if (value <= -Math.PI) {
      value += twoPi;
    }
    return value;
  },

  /** New bearing per frame: the remaining gap to the target is multiplied by the half-life factor. */
  steppedBearing(current: number, target: number, deltaTime: number, halfLife: number, maximumAbsoluteBearing: number): number {
    const sanitizedHalfLife = Math.max(0.001, Number.isFinite(halfLife) ? halfLife : 0.001);
    const factor = Math.exp((-Math.log(2.0) * deltaTime) / sanitizedHalfLife);
    const delta = CameraBearingFollowMath.followDelta(current, target, maximumAbsoluteBearing);
    return current + delta * (1 - factor);
  },

  shouldSnap(current: number, target: number): boolean {
    return Math.abs(CameraBearingFollowMath.shortestDelta(current, target)) <= CameraBearingFollowMath.snapThreshold;
  },

  /**
   * True if the bearing is stuck (hit a constraint at its limit): no progress
   * between frames, yet the target is not reached. The follow must stop
   * instead of keeping the frames coming forever.
   */
  isStalled(current: number, previous: number, target: number): boolean {
    return (
      Math.abs(CameraBearingFollowMath.shortestDelta(previous, current)) <= CameraBearingFollowMath.progressThreshold &&
      Math.abs(CameraBearingFollowMath.shortestDelta(current, target)) > CameraBearingFollowMath.snapThreshold
    );
  },
} as const;
