// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraUniform } from "../camera/camera-uniform.ts";
import type { GlobeUniform } from "../globe/globe-uniform.ts";
import { cutClearanceOf, horizonAlphaOf, worldPositionInto } from "../globe/globe-unroll-math.ts";
import { type Mat4, mat4FromColumns, mat4TransformInto, mat4Transpose } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import type { ResolvedPresentationState, ScreenSpaceProjectionMode } from "../presentation/resolved-presentation-state.ts";
import type { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

/**
 * A projected point: drawable pixels (origin bottom-left, y up), the NDC
 * depth, whether it is in front of the camera and on the visible side of the
 * globe, and its soft horizon alpha. Mutable, so a caller projecting many
 * points reuses one.
 */
export interface ScreenPointOutput {
  positionX: number;
  positionY: number;
  depth: number;
  /** 1 visible, 0 hidden, as the GPU struct carries it. */
  visible: number;
  visibilityAlpha: number;
}

export function makeScreenPointOutput(): ScreenPointOutput {
  return { positionX: 0, positionY: 0, depth: 0, visible: 0, visibilityAlpha: 0 };
}

const clipScratch = [0, 0, 0, 0];
const positionScratch = [0, 0, 0];

/**
 * Per-frame constants: computed once per frame, so `project` stays
 * per-point linear algebra.
 */
export class GeoScreenProjectionFrameConstants {
  readonly mode: ScreenSpaceProjectionMode;
  readonly viewport: Vec2;
  readonly cameraUniform: CameraUniform;
  readonly flatRenderMapSize: number;
  readonly flatPan: Vec2;
  readonly globe: GlobeUniform;
  readonly globeMapSize: number;
  readonly globePanMercatorY: number;
  readonly globeTransposedRotationMatrix: Mat4;

  /** `drawWidth` and `drawHeight` are the drawable's size in device pixels. */
  constructor(drawWidth: number, drawHeight: number, cameraUniform: CameraUniform, resolvedPresentation: ResolvedPresentationState) {
    this.mode = resolvedPresentation.screenSpaceProjectionMode;
    this.viewport = [drawWidth, drawHeight];
    this.cameraUniform = cameraUniform;
    this.flatRenderMapSize = resolvedPresentation.flatRenderState.renderMapSize;
    this.flatPan = resolvedPresentation.flatRenderState.pan;

    const globe = resolvedPresentation.globeRenderState.globeUniform;
    this.globe = globe;
    const panLatitude = globe.panY * ImmersiveMapProjection.maxMercatorLatitude;
    const panLongitude = globe.panX * Math.PI;
    // Mirror of globeTransitionMapSize: the flat morph target grows from
    // cos(center latitude) up to the full Mercator size.
    const distortion = Math.cos(panLatitude);
    const mapSizeScale = (1.0 - globe.transition) * distortion + globe.transition;
    this.globeMapSize = 2.0 * Math.PI * globe.radius * mapSizeScale;
    this.globePanMercatorY = ImmersiveMapProjection.yMercatorNormalized(panLatitude);
    const rotation = makeRotationMatrix(panLatitude, panLongitude);
    this.globeTransposedRotationMatrix = mat4Transpose(rotation, rotation);
  }

  rotatedSphereWorldPosition(sphereUnit: Vec3): Vec3 {
    this.rotatedSphereInto(positionScratch, sphereUnit[0], sphereUnit[1], sphereUnit[2]);
    return [positionScratch[0]!, positionScratch[1]!, positionScratch[2]!];
  }

  /** `rotatedSphereWorldPosition` written into `out[0..2]`. */
  rotatedSphereInto(out: number[] | Float64Array, ux: number, uy: number, uz: number): void {
    const radius = this.globe.radius;
    mat4TransformInto(clipScratch, this.globeTransposedRotationMatrix, ux * radius, uy * radius, uz * radius, 1.0);
    out[0] = clipScratch[0]!;
    out[1] = clipScratch[1]!;
    out[2] = clipScratch[2]! - radius;
  }

  globeFlatWorldPosition(basis: GeoProjectionBasis): Vec3 {
    this.globeFlatInto(positionScratch, basis);
    return [positionScratch[0]!, positionScratch[1]!, 0.0];
  }

  /** `globeFlatWorldPosition`'s x and y written into `out[0..1]`. */
  globeFlatInto(out: number[] | Float64Array, basis: GeoProjectionBasis): void {
    const mapSize = this.globeMapSize;
    const halfMapSize = mapSize * 0.5;
    const worldX = basis.normalizedWorldX * mapSize;
    out[0] = ImmersiveMapProjection.wrap(worldX - halfMapSize + this.globe.panX * halfMapSize, mapSize);
    out[1] = (basis.mercatorYNormalized - this.globePanMercatorY) * halfMapSize;
  }
}

function makeRotationMatrix(panLatitude: number, panLongitude: number): Mat4 {
  const cx = Math.cos(-panLatitude);
  const sx = Math.sin(-panLatitude);
  const cy = Math.cos(-panLongitude);
  const sy = Math.sin(-panLongitude);
  return mat4FromColumns([cy, 0, -sy, 0], [sy * sx, cx, cy * sx, 0], [sy * cx, -sx, cy * cx, 0], [0, 0, 0, 1]);
}

const sphereScratch = [0, 0, 0];
const flatScratch = [0, 0];
const worldScratch = [0, 0, 0];

/**
 * Unified CPU projector of a geo coordinate into a drawable screen point
 * (pixels, origin bottom-left, y up), consistent with the render vertex
 * path: the globe shaders' `globeProjectLatLon` and the sphere-to-plane
 * unroll (mirrored by `GlobeUnrollMath`). Change only in sync with the
 * shaders.
 */
export const GeoScreenProjectionMath = {
  /** Half-width of the horizon smoothing band in normalized dot space. */
  horizonFadeBandWidth: 0.03,

  /**
   * Projects one point into `out` (a fresh one when omitted) and returns it.
   * With `out` given, nothing is allocated.
   */
  project(basis: GeoProjectionBasis, constants: GeoScreenProjectionFrameConstants, out: ScreenPointOutput = makeScreenPointOutput()): ScreenPointOutput {
    if (constants.mode === "flat") {
      projectFlat(basis, constants, out);
    } else {
      projectGlobe(basis, constants, out);
    }
    return out;
  },

  /**
   * Soft horizon against the unrolling sphere the surface lives on
   * (`GlobeUnrollMath.horizonAlpha`), times the unroll's cut: a point whose
   * remaining chart travel is long is hidden exactly like the ground under
   * it (`GlobeUnrollMath.cutClearance`), so a marker never flies across the
   * view on its way to its Mercator home.
   */
  globeVisibility(
    worldPosition: Vec3,
    sphereWorldPosition: Vec3,
    flatWorldPosition: Vec2,
    constants: GeoScreenProjectionFrameConstants,
  ): { visible: boolean; alpha: number } {
    const alpha = globeVisibilityAlpha(
      worldPosition[0],
      worldPosition[1],
      worldPosition[2],
      sphereWorldPosition[0],
      sphereWorldPosition[1],
      sphereWorldPosition[2],
      flatWorldPosition[0],
      flatWorldPosition[1],
      constants,
    );
    return { visible: alpha > 0.0, alpha };
  },
} as const;

function globeVisibilityAlpha(
  wx: number,
  wy: number,
  wz: number,
  sx: number,
  sy: number,
  sz: number,
  fx: number,
  fy: number,
  constants: GeoScreenProjectionFrameConstants,
): number {
  const globe = constants.globe;
  let alpha = horizonAlphaOf(wx, wy, wz, constants.cameraUniform.eye, globe.transition, globe.radius);
  if (globe.transition > 0) {
    const clearance = cutClearanceOf(sx, sy, sz, fx, fy, globe.transition, globe.radius);
    const t = Math.min(Math.max(clearance / 0.05, 0.0), 1.0);
    alpha *= t * t * (3.0 - 2.0 * t);
  }
  return alpha;
}

function projectFlat(basis: GeoProjectionBasis, constants: GeoScreenProjectionFrameConstants, out: ScreenPointOutput): void {
  const mapSize = constants.flatRenderMapSize;
  const halfMapSize = mapSize * 0.5;
  const xWorld = ImmersiveMapProjection.wrap(basis.normalizedWorldX * mapSize - halfMapSize + constants.flatPan[0] * halfMapSize, mapSize);
  const yWorld = (basis.mercatorYNormalized - constants.flatPan[1]) * halfMapSize;
  mat4TransformInto(clipScratch, constants.cameraUniform.matrix, xWorld, yWorld, 0.0, 1.0);
  screenPointFromClip(constants.viewport, out);
}

function projectGlobe(basis: GeoProjectionBasis, constants: GeoScreenProjectionFrameConstants, out: ScreenPointOutput): void {
  const globe = constants.globe;
  const unit = basis.sphereUnit;
  constants.rotatedSphereInto(sphereScratch, unit[0], unit[1], unit[2]);
  const sx = sphereScratch[0]!, sy = sphereScratch[1]!, sz = sphereScratch[2]!;
  let fx = 0;
  let fy = 0;
  if (globe.transition <= 0.0) {
    worldScratch[0] = sx;
    worldScratch[1] = sy;
    worldScratch[2] = sz;
  } else {
    constants.globeFlatInto(flatScratch, basis);
    fx = flatScratch[0]!;
    fy = flatScratch[1]!;
    worldPositionInto(worldScratch, sx, sy, sz, fx, fy, globe.transition, globe.radius);
  }
  const wx = worldScratch[0]!, wy = worldScratch[1]!, wz = worldScratch[2]!;
  mat4TransformInto(clipScratch, constants.cameraUniform.matrix, wx, wy, wz, 1.0);
  screenPointFromClip(constants.viewport, out);
  if (out.visible === 0) {
    return;
  }

  const alpha = globeVisibilityAlpha(wx, wy, wz, sx, sy, sz, fx, fy, constants);
  if (!(alpha > 0.0)) {
    out.visible = 0;
    out.visibilityAlpha = 0.0;
    return;
  }
  out.visibilityAlpha = alpha;
}

/** The point of `clipScratch` on the screen. */
function screenPointFromClip(viewport: Vec2, out: ScreenPointOutput): void {
  const w = clipScratch[3]!;
  if (!(w > 0.0)) {
    out.positionX = 0;
    out.positionY = 0;
    out.depth = 0.0;
    out.visible = 0;
    out.visibilityAlpha = 0.0;
    return;
  }
  out.positionX = ((clipScratch[0]! / w) * 0.5 + 0.5) * viewport[0];
  out.positionY = ((clipScratch[1]! / w) * 0.5 + 0.5) * viewport[1];
  out.depth = clipScratch[2]! / w;
  out.visible = 1;
  out.visibilityAlpha = 1.0;
}
