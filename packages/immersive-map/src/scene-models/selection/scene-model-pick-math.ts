// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Mat4, mat4Multiply, mat4TransformInto } from "../../math/matrix.ts";
import { mat4Invert } from "../../math/mat4-invert.ts";
import type { Vec3 } from "../../math/vec.ts";

export interface SceneModelPickRay {
  readonly origin: Vec3;
  /** Unit length, so an intersection parameter is a render-space distance. */
  readonly direction: Vec3;
}

/** A screen rectangle in drawable pixels, origin bottom left. */
export interface SceneModelScreenRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Degenerate input (a zero-scaled model, a point behind the camera) produces
 * non-finite intermediates: every result is checked rather than trusted.
 */
const epsilon = 1e-6;

const inverseScratch = new Float64Array(16);
const clipMatrixScratch = new Float64Array(16);
const vectorScratch = [0, 0, 0, 0];

/**
 * Ray geometry behind scene model hit-testing, a port of the Swift
 * `SceneModelPickMath`.
 *
 * Scene models are rigid: `SceneModelAnchorMath` evaluates the
 * sphere-to-plane morph once per anchor and bakes it into a model matrix, and
 * the vertex shader is a plain `projectionView * modelMatrix * position`. So
 * the same two matrices invert into an exact picking ray, and a hit means the
 * tap landed on the model where it is drawn, in flat mode, on the globe, and
 * mid-morph alike. No approximation of the projection is involved, only of
 * the mesh.
 */
export const SceneModelPickMath = Object.freeze({
  /**
   * The world-space ray under a screen point, given in drawable pixels with
   * the origin bottom left and y up: the convention `GeoScreenProjectionMath`
   * projects into, inverted.
   *
   * The camera eye is the apex of the perspective frustum, so it is the
   * exact ray origin, and one unprojected far-plane point fixes the
   * direction.
   */
  makeRay(pixelX: number, pixelY: number, drawWidth: number, drawHeight: number, projectionView: Mat4, cameraEye: Vec3): SceneModelPickRay | null {
    if (!(drawWidth > 0) || !(drawHeight > 0)) return null;
    if (!mat4Invert(inverseScratch, projectionView)) return null;
    const ndcX = (pixelX / drawWidth) * 2 - 1;
    const ndcY = (pixelY / drawHeight) * 2 - 1;
    mat4TransformInto(vectorScratch, inverseScratch, ndcX, ndcY, 1, 1);
    const w = vectorScratch[3]!;
    if (!Number.isFinite(w) || !(Math.abs(w) > epsilon)) return null;

    const dx = vectorScratch[0]! / w - cameraEye[0];
    const dy = vectorScratch[1]! / w - cameraEye[1];
    const dz = vectorScratch[2]! / w - cameraEye[2];
    const length = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(length) || !(length > epsilon)) return null;
    return { origin: cameraEye, direction: [dx / length, dy / length, dz / length] };
  },

  /**
   * Distance from the ray origin to where it enters the model's bounding
   * box, null on a miss.
   *
   * The ray is carried into the model's own space instead of the box being
   * carried out of it, which makes this an oriented-box test: an aircraft
   * keeps a hit volume the shape of the aircraft rather than the bounding
   * sphere's mostly empty ball. An affine transform preserves the ray
   * parameter, so the returned distance is still in render-space units.
   */
  intersectionDistance(ray: SceneModelPickRay, boundsMin: Vec3, boundsMax: Vec3, inverseModelMatrix: Mat4): number | null {
    mat4TransformInto(vectorScratch, inverseModelMatrix, ray.origin[0], ray.origin[1], ray.origin[2], 1);
    const origin = [vectorScratch[0]!, vectorScratch[1]!, vectorScratch[2]!] as const;
    mat4TransformInto(vectorScratch, inverseModelMatrix, ray.direction[0], ray.direction[1], ray.direction[2], 0);
    const direction = [vectorScratch[0]!, vectorScratch[1]!, vectorScratch[2]!] as const;

    let entry = 0;
    let exit = Number.MAX_VALUE;
    for (let axis = 0; axis < 3; axis++) {
      const o = origin[axis]!;
      const d = direction[axis]!;
      // Parallel to this slab: the ray either runs inside it forever or
      // never enters it, and dividing would hand back an infinity.
      if (!(Math.abs(d) > epsilon)) {
        if (!(o >= boundsMin[axis]!) || !(o <= boundsMax[axis]!)) return null;
        continue;
      }
      const inverseDirection = 1 / d;
      let near = (boundsMin[axis]! - o) * inverseDirection;
      let far = (boundsMax[axis]! - o) * inverseDirection;
      if (!Number.isFinite(near) || !Number.isFinite(far)) return null;
      if (near > far) [near, far] = [far, near];
      entry = Math.max(entry, near);
      exit = Math.min(exit, far);
      if (!(entry <= exit)) return null;
    }

    // `entry` starts at zero, so a camera inside the box hits at distance 0
    // rather than behind itself.
    return entry;
  },

  /**
   * Screen rectangle spanned by the box's eight corners, in the same pixel
   * convention as `makeRay`. Null when any corner sits behind the camera:
   * the rectangle would be meaningless, and the only caller wants models
   * small enough to be entirely in front.
   */
  screenBounds(boundsMin: Vec3, boundsMax: Vec3, modelMatrix: Mat4, projectionView: Mat4, drawWidth: number, drawHeight: number): SceneModelScreenRect | null {
    if (!(drawWidth > 0) || !(drawHeight > 0)) return null;
    const clipMatrix = mat4Multiply(clipMatrixScratch, projectionView, modelMatrix);
    let minX = Number.MAX_VALUE;
    let minY = Number.MAX_VALUE;
    let maxX = -Number.MAX_VALUE;
    let maxY = -Number.MAX_VALUE;
    for (let corner = 0; corner < 8; corner++) {
      mat4TransformInto(
        vectorScratch,
        clipMatrix,
        (corner & 1) === 0 ? boundsMin[0] : boundsMax[0],
        (corner & 2) === 0 ? boundsMin[1] : boundsMax[1],
        (corner & 4) === 0 ? boundsMin[2] : boundsMax[2],
        1,
      );
      const w = vectorScratch[3]!;
      if (!(w > epsilon)) return null;
      const x = ((vectorScratch[0]! / w) * 0.5 + 0.5) * drawWidth;
      const y = ((vectorScratch[1]! / w) * 0.5 + 0.5) * drawHeight;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
  },

  /** Distance from the camera to the box center, the depth order used where there is no ray parameter to compare. */
  distanceFromCamera(boundsMin: Vec3, boundsMax: Vec3, modelMatrix: Mat4, cameraEye: Vec3): number {
    mat4TransformInto(
      vectorScratch,
      modelMatrix,
      (boundsMin[0] + boundsMax[0]) * 0.5,
      (boundsMin[1] + boundsMax[1]) * 0.5,
      (boundsMin[2] + boundsMax[2]) * 0.5,
      1,
    );
    return Math.hypot(vectorScratch[0]! - cameraEye[0], vectorScratch[1]! - cameraEye[1], vectorScratch[2]! - cameraEye[2]);
  },
});
