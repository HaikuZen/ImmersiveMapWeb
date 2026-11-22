// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "./vec.ts";

/** The decay of a released pan's velocity, in CSS pixels per second. */
export const GlobeCameraPanInertiaMath = {
  maximumDeltaTime: 0.05,

  speed(velocity: Vec2): number {
    return Math.hypot(velocity[0], velocity[1]);
  },

  shouldStart(velocity: Vec2, activationVelocity: number): boolean {
    return GlobeCameraPanInertiaMath.speed(velocity) >= Math.max(0, activationVelocity);
  },

  shouldStop(velocity: Vec2, stopVelocity: number): boolean {
    return GlobeCameraPanInertiaMath.speed(velocity) <= Math.max(0, stopVelocity);
  },

  clampedInitialVelocity(velocity: Vec2, maximumVelocity: number): Vec2 {
    const limit = Math.max(0, maximumVelocity);
    const speed = GlobeCameraPanInertiaMath.speed(velocity);
    if (!Number.isFinite(speed) || !(speed > 0) || !(speed > limit) || !(limit > 0)) {
      return velocity;
    }
    const scale = limit / speed;
    return [velocity[0] * scale, velocity[1] * scale];
  },

  clampedDeltaTime(deltaTime: number): number {
    if (!Number.isFinite(deltaTime)) {
      return 0;
    }
    return Math.min(Math.max(0, deltaTime), GlobeCameraPanInertiaMath.maximumDeltaTime);
  },

  decayedVelocity(velocity: Vec2, deltaTime: number, halfLife: number): Vec2 {
    const sanitizedHalfLife = Math.max(0.001, Number.isFinite(halfLife) ? halfLife : 0.001);
    const factor = Math.exp((-Math.log(2.0) * deltaTime) / sanitizedHalfLife);
    return [velocity[0] * factor, velocity[1] * factor];
  },
} as const;
