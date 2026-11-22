// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { mat4TransformInto, type Mat4 } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";

/**
 * The visible edge of the surface, as the camera sees it: the limb of the
 * sphere the surface currently lives on, or the plane's horizon. A port of
 * the Swift `HorizonEdgeMath`, the CPU mirror of `horizonAngleAboveEdge` in
 * horizon.wgsl, term for term.
 *
 * The unroll keeps the surface a sphere of curvature `(1 - t) / R` tangent
 * to the view centre, centred at `(0, 0, -1 / curvature)`. The plane is
 * curvature zero. Everything here is written in the curvature, so the plane
 * is the limit of the formulas and never a branch:
 *
 * - the eye's local vertical is `normalize(curvature * eye + (0, 0, 1))`,
 *   which is `(0, 0, 1)` on the plane;
 * - the limb sits below that vertical by `atan(limbDistance * curvature)`,
 *   where `(limbDistance * curvature)^2 = curvature^2 |eye|^2 + 2 curvature
 *   eye.z` (the eye's distance to the limb point, without ever forming the
 *   sphere's huge centre coordinate), which is zero on the plane.
 *
 * A view direction's angle above the edge is its elevation above the
 * vertical's horizontal plane plus the limb's depression: on the resting
 * sphere the classic `acos(dir . toCenter) - asin(R / d)`, on the plane
 * `asin(direction.z)`.
 */
export interface HorizonEdge {
  /** The eye's local vertical, a unit vector. */
  readonly up: Vec3;
  /** How far below the local horizontal the edge lies, radians. */
  readonly depression: number;
  /** Distance from the eye to the limb point, infinite on the plane. */
  readonly limbDistance: number;
}

const farClip = [0, 0, 0, 0];

export const HorizonEdgeMath = {
  edge(eye: Vec3, curvature: number): HorizonEdge {
    const c = Math.max(curvature, 0);
    const ux = c * eye[0];
    const uy = c * eye[1];
    const uz = c * eye[2] + 1;
    const length = Math.hypot(ux, uy, uz);
    const scaledLimbDistance = Math.sqrt(Math.max(c * c * (eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]) + 2 * c * eye[2], 0));
    return {
      up: [ux / length, uy / length, uz / length],
      depression: Math.atan(scaledLimbDistance),
      limbDistance: c > 0 ? scaledLimbDistance / c : Number.POSITIVE_INFINITY,
    };
  },

  /** Signed angle of a unit view direction above the edge: positive looks past the surface into the sky, negative at the surface. */
  angleAboveEdge(direction: Vec3, edge: HorizonEdge): number {
    const dot = direction[0] * edge.up[0] + direction[1] * edge.up[1] + direction[2] * edge.up[2];
    return Math.asin(Math.min(Math.max(dot, -1), 1)) + edge.depression;
  },

  /**
   * The view ray through a point of the viewport, from its far-plane point
   * back to the eye. A degenerate projection yields the vertical instead of
   * a division by zero.
   */
  viewDirection(ndcX: number, ndcY: number, inverseProjectionView: Mat4, eye: Vec3): Vec3 {
    mat4TransformInto(farClip, inverseProjectionView, ndcX, ndcY, 1, 1);
    const w = farClip[3]!;
    if (Math.abs(w) <= 1e-9) return [0, 0, 1];
    const dx = farClip[0]! / w - eye[0];
    const dy = farClip[1]! / w - eye[1];
    const dz = farClip[2]! / w - eye[2];
    const length = Math.hypot(dx, dy, dz);
    return [dx / length, dy / length, dz / length];
  },

  /** The four viewport corner rays. */
  cornerDirections(inverseProjectionView: Mat4, eye: Vec3): Vec3[] {
    const directions: Vec3[] = [];
    for (const cornerX of [-1, 1]) {
      for (const cornerY of [-1, 1]) directions.push(HorizonEdgeMath.viewDirection(cornerX, cornerY, inverseProjectionView, eye));
    }
    return directions;
  },

  /**
   * True when some pixel of the frame looks within `reachBelow` radians of
   * the edge or above it, which is when the horizon layer has anything to
   * paint. The set of directions farther below the edge than the reach is a
   * cone about the nadir, convex on screen, so the frame lies entirely
   * inside it if and only if its four corners do.
   */
  isEdgeWithinReach(edge: HorizonEdge, reachBelow: number, inverseProjectionView: Mat4, eye: Vec3): boolean {
    return HorizonEdgeMath.cornerDirections(inverseProjectionView, eye).some((d) => HorizonEdgeMath.angleAboveEdge(d, edge) >= -reachBelow);
  },
} as const;
