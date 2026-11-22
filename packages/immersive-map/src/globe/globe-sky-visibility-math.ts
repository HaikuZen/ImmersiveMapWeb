// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { mat4TransformInto, type Mat4 } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";

const farClip = [0, 0, 0, 0];

/**
 * Whether any sky is visible around the resting sphere, a port of the Swift
 * `GlobeSkyVisibilityMath`: the space decor (the stars) is skipped for the
 * frame when the planet fills the whole viewport, which is every region
 * zoom. The sphere's screen projection is convex, so the frame shows sky if
 * and only if at least one of its corners does. Four ray-sphere tests
 * decide the frame.
 *
 * Valid on the resting sphere only (transition 0): mid-morph the surface
 * leaves the sphere the test intersects, and the decor is drawn as before.
 */
export const GlobeSkyVisibilityMath = {
  /** True when at least one viewport corner ray misses the planet (or the planet is behind the eye there). */
  isSkyVisible(inverseProjectionView: Mat4, eye: Vec3, radius: number): boolean {
    const tx = -eye[0];
    const ty = -eye[1];
    const tz = -radius - eye[2];
    for (const cornerX of [-1, 1]) {
      for (const cornerY of [-1, 1]) {
        mat4TransformInto(farClip, inverseProjectionView, cornerX, cornerY, 1, 1);
        const w = farClip[3]!;
        if (Math.abs(w) <= 1e-9) return true;
        let dx = farClip[0]! / w - eye[0];
        let dy = farClip[1]! / w - eye[1];
        let dz = farClip[2]! / w - eye[2];
        const length = Math.hypot(dx, dy, dz);
        dx /= length;
        dy /= length;
        dz /= length;
        const along = tx * dx + ty * dy + tz * dz;
        // The planet is behind the eye along this corner: sky.
        if (along <= 0) return true;
        const perpendicularSquared = tx * tx + ty * ty + tz * tz - along * along;
        // The corner ray misses the planet: sky.
        if (perpendicularSquared > radius * radius) return true;
      }
    }
    return false;
  },
} as const;
