// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraBearingFollowMath } from "../math/camera-bearing-follow-math.ts";

/** Whether the bearing follow smooths, and its half-life (a non-finite one is 0.06 s, never under a millisecond). */
export class CameraBearingFollowConfiguration {
  readonly isEnabled: boolean;
  readonly halfLife: number;

  constructor(isEnabled: boolean, halfLife: number) {
    this.isEnabled = isEnabled;
    this.halfLife = Math.max(0.001, Number.isFinite(halfLife) ? halfLife : 0.06);
  }
}

export interface CameraBearingFollowStep {
  readonly bearing: number;
  readonly isActive: boolean;
}

/**
 * Time-based follower for camera bearing: the control sets the target angle
 * instantly, while the actual bearing converges to it exponentially every
 * frame (half-life), along the shortest angular path when rotation is
 * unbounded and along the in-window path under a bearing cap. Removes
 * rotation jerkiness caused by the uneven event rate of the slider or
 * gesture.
 *
 * Ported from the Swift engine's `UI/Camera` with its math, which its tests
 * exercise together.
 */
export class CameraBearingFollow {
  private configuration: CameraBearingFollowConfiguration;
  private isActive = false;
  private target = 0;
  private lastTickTime: number | null = null;
  private previousBearing: number | null = null;
  /** Whether the last step asked the camera to move by more than the progress threshold. */
  private previousStepAskedForProgress = false;

  constructor(configuration: CameraBearingFollowConfiguration) {
    this.configuration = configuration;
  }

  get active(): boolean {
    return this.isActive;
  }

  /** The bearing the follow is heading to, `null` when it is at rest. */
  get pendingTarget(): number | null {
    return this.isActive ? this.target : null;
  }

  updateConfiguration(configuration: CameraBearingFollowConfiguration): boolean {
    this.configuration = configuration;
    if (!configuration.isEnabled) {
      this.cancel();
    }
    return this.isActive;
  }

  /**
   * Sets a new target. Returns false if follow is disabled by settings, and
   * then the caller must apply the bearing instantly.
   */
  retarget(bearing: number, currentTime: number): boolean {
    if (!this.configuration.isEnabled) {
      this.cancel();
      return false;
    }
    this.target = bearing;
    if (!this.isActive) {
      this.lastTickTime = currentTime;
      this.previousBearing = null;
      this.isActive = true;
    }
    return true;
  }

  /** One frame at `currentTime` seconds, under a bearing cap of `maximumAbsoluteBearing`. */
  advance(currentBearing: number, currentTime: number, maximumAbsoluteBearing: number = Math.PI): CameraBearingFollowStep {
    if (!this.isActive) {
      return { bearing: currentBearing, isActive: false };
    }
    const lastTickTime = this.lastTickTime;
    if (lastTickTime === null) {
      this.lastTickTime = currentTime;
      this.previousBearing = currentBearing;
      this.previousStepAskedForProgress = false;
      return { bearing: currentBearing, isActive: true };
    }

    const deltaTime = CameraBearingFollowMath.clampedDeltaTime(currentTime - lastTickTime);
    this.lastTickTime = currentTime;
    if (!(deltaTime > 0)) {
      return { bearing: currentBearing, isActive: true };
    }

    // A stall is a step the camera refused: the last step asked for a real
    // move and the camera did not make it (a clamp, the ceiling). A step that
    // itself asked for less than the threshold is no evidence: the first one
    // after a retarget spans only the moment between a pointer event and its
    // frame, a fraction of a millisecond in a browser, and counting it
    // cancelled the follow on every other frame, so a turn stood still.
    if (this.previousBearing !== null && this.previousStepAskedForProgress && CameraBearingFollowMath.isStalled(currentBearing, this.previousBearing, this.target)) {
      this.cancel();
      return { bearing: currentBearing, isActive: false };
    }

    if (CameraBearingFollowMath.shouldSnap(currentBearing, this.target)) {
      this.cancel();
      return { bearing: this.target, isActive: false };
    }

    const nextBearing = CameraBearingFollowMath.steppedBearing(
      currentBearing,
      this.target,
      deltaTime,
      this.configuration.halfLife,
      maximumAbsoluteBearing,
    );
    this.previousBearing = currentBearing;
    this.previousStepAskedForProgress = Math.abs(nextBearing - currentBearing) > CameraBearingFollowMath.progressThreshold;
    return { bearing: nextBearing, isActive: true };
  }

  cancel(): void {
    this.isActive = false;
    this.lastTickTime = null;
    this.previousBearing = null;
  }
}
