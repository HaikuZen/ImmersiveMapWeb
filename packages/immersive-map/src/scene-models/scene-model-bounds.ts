// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec3 } from "../math/vec.ts";

/**
 * A model asset's bounds in asset space (before the Y-up to Z-up anchor
 * conversion), the Swift `SceneModelMesh.Bounds`. The rotation-invariant
 * radius and extent survive the conversion unchanged. The box is the stored
 * truth and the rest is derived from it, so sizing, culling and hit-testing
 * cannot disagree about how large a model is.
 */
export interface SceneModelBounds {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly center: Vec3;
  /** Bounding sphere of the box, the radius frustum culling uses. */
  readonly radius: number;
  /** Longest edge of the box, what `fitDiameterMeters` is measured against. */
  readonly maxExtent: number;
}

export function makeSceneModelBounds(minimum: Vec3, maximum: Vec3): SceneModelBounds {
  const extentX = maximum[0] - minimum[0];
  const extentY = maximum[1] - minimum[1];
  const extentZ = maximum[2] - minimum[2];
  return Object.freeze({
    minimum,
    maximum,
    center: [(minimum[0] + maximum[0]) * 0.5, (minimum[1] + maximum[1]) * 0.5, (minimum[2] + maximum[2]) * 0.5] as const,
    radius: Math.max(Math.hypot(extentX, extentY, extentZ) * 0.5, 1e-6),
    maxExtent: Math.max(extentX, extentY, extentZ, 1e-6),
  });
}
