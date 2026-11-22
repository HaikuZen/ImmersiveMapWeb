// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Mat4, Matrix, mat4Identity, mat4Multiply } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";
import { Frustum } from "./frustum.ts";

/**
 * One style rank step of the ground's depth bands (Swift
 * `GlobeSurfaceDepthRank.layerDepthStep`), mirrored here for the real depth
 * scale. The tile drawers own the rest of the band.
 */
const layerDepthStep = 3.2e-6;
/**
 * The rank of the buildings, the models and the trees (Swift
 * `GlobeSurfaceDepthRank.realGeometryRank`): nearer than every ground layer
 * and every label painted on the ground.
 */
const realGeometryRank = 1_536;

function zRow(near: number, far: number): { zScale: number; wzScale: number } {
  return { zScale: -(far + near) / (far - near), wzScale: (-2 * far * near) / (far - near) };
}

/**
 * The render camera: the eye, the point it looks at and the up vector, the
 * projection, the view and their product, and the frustum of that product.
 * Every matrix is preallocated and rewritten in place, so recomputing the
 * pose each frame allocates nothing but the new eye and up tuples.
 */
export class RenderCamera {
  /**
   * The fixed vertical field of view of the render camera, read by the
   * horizon frame resolver as well.
   */
  static readonly verticalFovRadians = Math.PI / 4;
  /** The near plane, in view units (the flat ground shader's near plane too). */
  static readonly nearPlane = 0.01;
  /**
   * The far plane of the matrices the CPU works with: the coverage, the
   * horizon and the picking unproject through them, and they want a far
   * plane close to the visible ground. The GPU draws with a far plane far
   * past it (`gpuFarPlane`).
   */
  static readonly farPlane = 200.0;
  /**
   * The far plane the GPU draws with. The flat ground's depth is the
   * projection's, so the ground ends at the far plane, and at 200 units it
   * ended a visible band under the horizon, the eye standing hundreds of
   * units over the ground at the middle zooms. The float depth keeps its
   * precision: it is near-plane dominated, and one rank step of the ground's
   * band is still many float steps at a thousand units. Only the camera
   * uniform carries it (`gpuClipDepthAdjustment`), as the real-depth scale.
   */
  static readonly gpuFarPlane = 100_000.0;
  /**
   * The scale the camera uniform the GPU draws with applies to the
   * projection's z, for everything real (the buildings, the models, the
   * markers): the flat ground writes its depth as the projection's z scaled
   * by its layer's rank instead, a scale of 1 minus up to 1220 rank steps for
   * the ground's layers and the labels painted on it, so the real geometry
   * takes a scale nearer than all of them, and a wall's base is never covered
   * by the ground behind it. The far plane moves 0.06 percent nearer, which
   * nothing sees. Only the uniform carries it: the matrices the CPU
   * unprojects with (the coverage, the horizon, the shadows, the picking)
   * stay the projection's own, since an NDC depth of 1 unprojected through
   * the scaled matrix is past the far plane.
   */
  static readonly realDepthScale = 1 - realGeometryRank * layerDepthStep;

  /**
   * The map from the CPU projection's clip z to the GPU's: the far plane
   * moved to `gpuFarPlane` and the z scaled by `realDepthScale`, both linear
   * in clip space (z' = a z + b w), so one matrix applied after the
   * projection-view does it and x, y and w are untouched. Never written to.
   */
  static readonly gpuClipDepthAdjustment: Mat4 = (() => {
    const cpu = zRow(RenderCamera.nearPlane, RenderCamera.farPlane);
    const gpu = zRow(RenderCamera.nearPlane, RenderCamera.gpuFarPlane);
    // The perspective's z_clip = zScale z_view + wzScale, and w_clip =
    // -z_view, so z_clip = -zScale w_clip + wzScale on both sides.
    const a = gpu.zScale / cpu.zScale;
    const b = gpu.wzScale - a * cpu.wzScale;
    const adjustment = mat4Identity();
    adjustment[10] = a * RenderCamera.realDepthScale;
    adjustment[14] = b * RenderCamera.realDepthScale;
    return adjustment;
  })();

  eye: Vec3 = [0, 0, 1];
  center: Vec3 = [0, 0, 0];
  up: Vec3 = [0, 1, 0];

  private readonly projectionMatrix: Mat4 = new Float64Array(16);
  private readonly viewMatrix: Mat4 = new Float64Array(16);
  private readonly projectionViewMatrix: Mat4 = new Float64Array(16);
  private readonly frustumValue = new Frustum();
  private hasProjection = false;
  private hasMatrix = false;

  /** The projection, null before `recalculateProjection`. The same array every frame. */
  get projection(): Mat4 | null {
    return this.hasProjection ? this.projectionMatrix : null;
  }

  /** The view matrix, null before the first `recalculateMatrix`. The same array every frame. */
  get view(): Mat4 | null {
    return this.hasMatrix ? this.viewMatrix : null;
  }

  /** `projection * view`, null before the first `recalculateMatrix`. The same array every frame. */
  get cameraMatrix(): Mat4 | null {
    return this.hasMatrix ? this.projectionViewMatrix : null;
  }

  /** The frustum of `cameraMatrix`, null before the first `recalculateMatrix`. The same object every frame. */
  get frustum(): Frustum | null {
    return this.hasMatrix ? this.frustumValue : null;
  }

  recalculateProjection(aspect: number): void {
    // The far plane is far past the visible ground (farPlane): the far clip
    // line would otherwise be a visible "horizon" whose position depends on
    // the zoom, since the render world's scale doubles with the zoom while
    // the clip stays at the same distance.
    Matrix.perspectiveMatrix(this.projectionMatrix, RenderCamera.verticalFovRadians, aspect, RenderCamera.nearPlane, RenderCamera.farPlane);
    this.hasProjection = true;
    this.recalculateMatrix();
  }

  recalculateMatrix(): void {
    if (!this.hasProjection) {
      throw new Error("Render camera projection must be set before recalculating matrices.");
    }
    Matrix.lookAt(this.viewMatrix, this.eye, this.center, this.up);
    mat4Multiply(this.projectionViewMatrix, this.projectionMatrix, this.viewMatrix);
    this.frustumValue.update(this.projectionViewMatrix);
    this.hasMatrix = true;
  }
}
