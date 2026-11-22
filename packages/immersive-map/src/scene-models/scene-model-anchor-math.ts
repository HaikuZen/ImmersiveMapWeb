// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { GeoSurfaceFrameMath } from "../geo/geo-surface-frame-math.ts";
import { type Mat4, Matrix, mat4FromColumns, mat4Identity, mat4Multiply, mat4TransformInto } from "../math/matrix.ts";
import { quatToMat4 } from "../math/quaternion.ts";
import type { Vec3 } from "../math/vec.ts";
import type { PresentedSceneModel } from "./presentation/scene-model-presentation-state-store.ts";
import type { SceneModelBounds } from "./scene-model-bounds.ts";

/**
 * The map surface under a scene model's anchor, in render space: the surface
 * point at altitude zero and the local up. A model's height above the ground
 * is measured against it, and a model that cuts into the ground is flattened
 * onto it for its ground hole.
 */
export interface SceneModelGroundPlane {
  readonly surfacePosition: Vec3;
  readonly up: Vec3;
}

/**
 * A scene model's anchor resolved for the current frame: the model matrix
 * placing the mesh on the (possibly mid-morph) map surface, the ground plane
 * under it, the world-space bounding sphere for frustum culling, and the
 * globe horizon visibility gate.
 */
export interface SceneModelAnchor {
  readonly modelMatrix: Mat4;
  readonly groundPlane: SceneModelGroundPlane;
  readonly boundingSphereCenter: Vec3;
  readonly boundingSphereRadius: number;
  /**
   * False when the anchor is beyond the globe horizon gate: the depth test
   * would hide the model anyway, this only skips the draw.
   */
  readonly passesHorizonGate: boolean;
}

const yUpToZUp = Matrix.rotationMatrixX(mat4Identity(), Math.PI / 2);
const orientationScratch = mat4Identity();
const scaleScratch = mat4Identity();
const centerScratch = [0, 0, 0, 0];

/**
 * Composes the model matrix on top of the surface frame resolved by
 * `GeoSurfaceFrameMath`, a port of the Swift `SceneModelAnchorMath`: the
 * morph is evaluated once per anchor, so a model sits exactly on the morph
 * geometry while staying rigid (no per-vertex shear). Computed in double
 * precision. The GPU side rounds the matrix to f32 when it writes it.
 */
export const SceneModelAnchorMath = Object.freeze({
  resolveAnchor(presented: PresentedSceneModel, bounds: SceneModelBounds, constants: GeoScreenProjectionFrameConstants): SceneModelAnchor {
    const frame = GeoSurfaceFrameMath.resolve(presented.projectionBasis, constants);

    const fitDiameterMeters = presented.fitDiameterMeters;
    const fitScale = fitDiameterMeters !== null && fitDiameterMeters > 0 ? fitDiameterMeters / bounds.maxExtent : 1;
    const scale = frame.unitsPerMeter * presented.scale * fitScale;
    const lift = presented.altitudeMeters * frame.unitsPerMeter;
    const position = frame.worldPosition;
    const up = frame.up;

    // Column-vector composition, rightmost first: uniform scale in asset
    // units, then the asset's Y-up to the anchor's Z-up, then heading, pitch
    // and roll in the tangent frame, then the tangent basis into render
    // space, then the translation to the anchor.
    const modelMatrix = mat4FromColumns(
      [frame.east[0], frame.east[1], frame.east[2], 0],
      [frame.north[0], frame.north[1], frame.north[2], 0],
      [up[0], up[1], up[2], 0],
      [position[0] + up[0] * lift, position[1] + up[1] * lift, position[2] + up[2] * lift, 1],
    );
    mat4Multiply(modelMatrix, modelMatrix, quatToMat4(orientationScratch, presented.orientation));
    mat4Multiply(modelMatrix, modelMatrix, yUpToZUp);
    mat4Multiply(modelMatrix, modelMatrix, Matrix.scaleMatrix(scaleScratch, scale, scale, scale));

    const center = bounds.center;
    mat4TransformInto(centerScratch, modelMatrix, center[0], center[1], center[2], 1);
    return {
      modelMatrix,
      groundPlane: { surfacePosition: position, up },
      boundingSphereCenter: [centerScratch[0]!, centerScratch[1]!, centerScratch[2]!],
      boundingSphereRadius: bounds.radius * scale,
      passesHorizonGate: frame.passesHorizonGate,
    };
  },
});
