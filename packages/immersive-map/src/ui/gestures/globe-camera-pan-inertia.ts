// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { GlobeCameraPanInertiaMath } from "../../math/globe-camera-pan-inertia-math.ts";
import type { Vec2 } from "../../math/vec.ts";

/** One frame of the inertia: the translation to pan by, in CSS pixels, and whether it carries on. */
export interface GlobeCameraPanInertiaStep {
  readonly translation: Vec2;
  readonly isActive: boolean;
}

/** The inertia's settings, sanitized: a non-finite value falls back to a default, a negative one to zero. */
export class GlobeCameraPanInertiaConfiguration {
  readonly isEnabled: boolean;
  readonly halfLife: number;
  readonly activationVelocity: number;
  readonly stopVelocity: number;
  readonly maximumInitialVelocity: number;

  constructor(isEnabled: boolean, halfLife: number, activationVelocity: number, stopVelocity: number, maximumInitialVelocity: number) {
    this.isEnabled = isEnabled;
    this.halfLife = Math.max(0.001, Number.isFinite(halfLife) ? halfLife : 0.28);
    this.activationVelocity = Math.max(0, Number.isFinite(activationVelocity) ? activationVelocity : 0);
    this.stopVelocity = Math.max(0, Number.isFinite(stopVelocity) ? stopVelocity : 0);
    this.maximumInitialVelocity = Math.max(0, Number.isFinite(maximumInitialVelocity) ? maximumInitialVelocity : 0);
  }
}

const zero: Vec2 = Object.freeze([0, 0] as const);

/**
 * Simulates post-pan inertia for globe camera movement. Holds the decay
 * state and returns translations for each frame until the motion stops.
 */
export class GlobeCameraPanInertia {
  private configuration: GlobeCameraPanInertiaConfiguration;
  private isActive = false;
  private velocity: Vec2 = zero;
  private lastTickTime: number | null = null;

  constructor(configuration: GlobeCameraPanInertiaConfiguration) {
    this.configuration = configuration;
  }

  get active(): boolean {
    return this.isActive;
  }

  updateConfiguration(configuration: GlobeCameraPanInertiaConfiguration): boolean {
    this.configuration = configuration;
    if (!configuration.isEnabled) {
      this.cancel();
    }
    return this.isActive;
  }

  /** Starts from the release velocity, in CSS pixels per second. False when it is too slow or the inertia is off. */
  start(initialVelocity: Vec2, currentTime: number): boolean {
    if (!this.configuration.isEnabled || !GlobeCameraPanInertiaMath.shouldStart(initialVelocity, this.configuration.activationVelocity)) {
      this.cancel();
      return false;
    }
    this.velocity = GlobeCameraPanInertiaMath.clampedInitialVelocity(initialVelocity, this.configuration.maximumInitialVelocity);
    this.lastTickTime = currentTime;
    this.isActive = true;
    return true;
  }

  advance(currentTime: number): GlobeCameraPanInertiaStep {
    if (!this.isActive) {
      return { translation: zero, isActive: false };
    }
    const lastTickTime = this.lastTickTime;
    if (lastTickTime === null) {
      this.lastTickTime = currentTime;
      return { translation: zero, isActive: this.isActive };
    }
    const deltaTime = GlobeCameraPanInertiaMath.clampedDeltaTime(currentTime - lastTickTime);
    this.lastTickTime = currentTime;
    if (!(deltaTime > 0)) {
      return { translation: zero, isActive: this.isActive };
    }

    const translation: Vec2 = [this.velocity[0] * deltaTime, this.velocity[1] * deltaTime];
    this.velocity = GlobeCameraPanInertiaMath.decayedVelocity(this.velocity, deltaTime, this.configuration.halfLife);
    if (GlobeCameraPanInertiaMath.shouldStop(this.velocity, this.configuration.stopVelocity)) {
      this.cancel();
    }
    return { translation, isActive: this.isActive };
  }

  cancel(): void {
    this.isActive = false;
    this.velocity = zero;
    this.lastTickTime = null;
  }
}
