// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraPitchFollowMath } from "../math/camera-pitch-follow-math.ts";

/** Whether the pitch follow smooths, and its half-life (a non-finite one is 0.06 s, never under a millisecond). */
export class CameraPitchFollowConfiguration {
  readonly isEnabled: boolean;
  readonly halfLife: number;

  constructor(isEnabled: boolean, halfLife: number) {
    this.isEnabled = isEnabled;
    this.halfLife = Math.max(0.001, Number.isFinite(halfLife) ? halfLife : 0.06);
  }
}

export interface CameraPitchFollowStep {
  readonly pitch: number;
  readonly isActive: boolean;
}

/**
 * Time-based follower for camera pitch: the gesture sets the target angle
 * instantly, while the actual pitch converges to it exponentially each frame
 * using a half-life. Removes tilt jerkiness caused by uneven touch-event
 * rates: the per-frame step is normalized by time, not by event count.
 *
 * Ported from the Swift engine's `UI/Camera` with its math, which its tests
 * exercise together.
 */
export class CameraPitchFollow {
  private configuration: CameraPitchFollowConfiguration;
  private isActive = false;
  private target = 0;
  private lastTickTime: number | null = null;
  private previousPitch: number | null = null;
  /** Whether the last step asked the camera to move by more than the progress threshold. */
  private previousStepAskedForProgress = false;

  constructor(configuration: CameraPitchFollowConfiguration) {
    this.configuration = configuration;
  }

  get active(): boolean {
    return this.isActive;
  }

  /** The pitch the follow is heading to, `null` when it is at rest. */
  get pendingTarget(): number | null {
    return this.isActive ? this.target : null;
  }

  updateConfiguration(configuration: CameraPitchFollowConfiguration): boolean {
    this.configuration = configuration;
    if (!configuration.isEnabled) {
      this.cancel();
    }
    return this.isActive;
  }

  /**
   * Sets a new target. Returns false if follow is disabled by the setting,
   * and then the caller must apply the pitch instantly.
   */
  retarget(pitch: number, currentTime: number): boolean {
    if (!this.configuration.isEnabled) {
      this.cancel();
      return false;
    }
    this.target = pitch;
    if (!this.isActive) {
      this.lastTickTime = currentTime;
      this.previousPitch = null;
      this.isActive = true;
    }
    return true;
  }

  /** One frame at `currentTime` seconds. */
  advance(currentPitch: number, currentTime: number): CameraPitchFollowStep {
    if (!this.isActive) {
      return { pitch: currentPitch, isActive: false };
    }
    const lastTickTime = this.lastTickTime;
    if (lastTickTime === null) {
      this.lastTickTime = currentTime;
      this.previousPitch = currentPitch;
      this.previousStepAskedForProgress = false;
      return { pitch: currentPitch, isActive: true };
    }

    const deltaTime = CameraPitchFollowMath.clampedDeltaTime(currentTime - lastTickTime);
    this.lastTickTime = currentTime;
    if (!(deltaTime > 0)) {
      return { pitch: currentPitch, isActive: true };
    }

    // A stall is a step the camera refused: the last step asked for a real
    // move and the camera did not make it (a clamp, the ceiling). A step that
    // itself asked for less than the threshold is no evidence: the first one
    // after a retarget spans only the moment between a pointer event and its
    // frame, a fraction of a millisecond in a browser, and counting it
    // cancelled the follow on every other frame, so a tilt stood still.
    if (this.previousPitch !== null && this.previousStepAskedForProgress && CameraPitchFollowMath.isStalled(currentPitch, this.previousPitch, this.target)) {
      this.cancel();
      return { pitch: currentPitch, isActive: false };
    }

    if (CameraPitchFollowMath.shouldSnap(currentPitch, this.target)) {
      this.cancel();
      return { pitch: this.target, isActive: false };
    }

    const nextPitch = CameraPitchFollowMath.steppedPitch(currentPitch, this.target, deltaTime, this.configuration.halfLife);
    this.previousPitch = currentPitch;
    this.previousStepAskedForProgress = Math.abs(nextPitch - currentPitch) > CameraPitchFollowMath.progressThreshold;
    return { pitch: nextPitch, isActive: true };
  }

  cancel(): void {
    this.isActive = false;
    this.lastTickTime = null;
    this.previousPitch = null;
  }
}
