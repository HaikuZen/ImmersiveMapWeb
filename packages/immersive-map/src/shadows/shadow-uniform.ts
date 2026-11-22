// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { mat4Identity, type Mat4 } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";

/**
 * The receivers' shadow parameters, a port of the Swift `ShadowCascadeUniform`
 * and `ShadowUniform`, and their layout in shadow.wgsl.
 *
 * `worldToShadowTexture` maps flat world space straight to the window's
 * slice of the shadow map: xy is the texture UV (v flipped for the top-left
 * texture origin WebGPU shares with Metal), z the comparison depth.
 */
export interface ShadowCascadeUniform {
  readonly worldToShadowTexture: Mat4;
  /**
   * The factor the tent's four taps are pushed out by, about the sample point
   * (`ShadowSettings.softness`, clamped). 1 is the plain 3x3 tent.
   */
  readonly tentSpread: number;
  /** Where the window's shadows start to fade, a radial distance from `ShadowUniform.fadeCenter`. */
  readonly fadeStartDistance: number;
  /** Receiver-side comparison bias in normalized shadow depth. */
  readonly depthBias: number;
  /** Where the window's shadows are gone. */
  readonly fadeEndDistance: number;
  /**
   * The valid UV rectangle, inset so the tent's taps never leave the window.
   * An empty rectangle (minimum past maximum) is a window the frame has not got.
   */
  readonly uvMinimum: Vec2;
  readonly uvMaximum: Vec2;
  /** World distance the receivers with normals step off their surface: `normalOffsetTexels` texels of this window. */
  readonly normalOffsetWorld: number;
  /** One texel of the window in UV. */
  readonly texelSizeUV: Vec2;
}

export interface ShadowUniform {
  /** The near window (`ShadowCascadeSlot` "near"). */
  readonly near: ShadowCascadeUniform;
  /** The far window, `ShadowCascadeUniform.disabled` when the frame has none. */
  readonly far: ShadowCascadeUniform;
  /** The camera eye in world space. */
  readonly eye: Vec3;
  /** Shadow darkening, 0 to 1: 0 disables sampling entirely. */
  readonly strength: number;
  /** Unit direction towards the static sun, for the geometric self-shadow test. */
  readonly lightDirection: Vec3;
  /** RGB cast of a fully shadowed surface (`ShadowSettings.tint`). */
  readonly tint: Vec3;
  /** Centre of the windows in world XY, which every fade distance is measured from: the camera's ground point. */
  readonly fadeCenter: Vec2;
}

const disabledCascade: ShadowCascadeUniform = Object.freeze({
  worldToShadowTexture: mat4Identity(),
  tentSpread: 1,
  fadeStartDistance: 0,
  depthBias: 0,
  fadeEndDistance: 1,
  uvMinimum: Object.freeze([1, 1] as const),
  uvMaximum: Object.freeze([-1, -1] as const),
  normalOffsetWorld: 0,
  texelSizeUV: Object.freeze([0, 0] as const),
});

export const ShadowCascadeUniform = {
  /** A window the frame has not got: an empty UV rectangle. */
  disabled: disabledCascade,
  /** Whether the frame has this window (the shader's `shadowCascadeIsEnabled`). */
  isEnabled(cascade: ShadowCascadeUniform): boolean {
    return cascade.uvMaximum[0] >= cascade.uvMinimum[0];
  },
} as const;

export const ShadowUniform = {
  /** Bound when the shadow pass is skipped: the shader's strength guard returns lit before touching the map. */
  disabled: Object.freeze({
    near: disabledCascade,
    far: disabledCascade,
    eye: Object.freeze([0, 0, 0] as const),
    strength: 0,
    lightDirection: Object.freeze([0, 0, 1] as const),
    tint: Object.freeze([1, 1, 1] as const),
    fadeCenter: Object.freeze([0, 0] as const),
  }) as ShadowUniform,
} as const;

/**
 * The byte layout of `ShadowCascade` and `Shadow` in shadow.wgsl, WGSL's
 * natural layout of these members:
 *
 * ```wgsl
 * struct ShadowCascade {
 *   worldToShadowTexture: mat4x4f, // 0
 *   tentSpread: f32,               // 64
 *   fadeStartDistance: f32,        // 68
 *   depthBias: f32,                // 72
 *   fadeEndDistance: f32,          // 76
 *   uvMinimum: vec2f,              // 80
 *   uvMaximum: vec2f,              // 88
 *   normalOffsetWorld: f32,        // 96
 *   padding: f32,                  // 100
 *   texelSizeUV: vec2f,            // 104
 * }                                // 112
 * struct Shadow {
 *   near: ShadowCascade,           // 0
 *   far: ShadowCascade,            // 112
 *   eyeAndStrength: vec4f,         // 224
 *   lightDirection: vec4f,         // 240
 *   tint: vec4f,                   // 256
 *   fadeCenter: vec2f,             // 272
 *   padding: vec2f,                // 280
 * }                                // 288
 * ```
 *
 * The Swift mirror is 304 bytes (its `SIMD3` members take 16 bytes each and
 * the strength sits after the eye's padding). Here the eye and the strength
 * share a vector, so the struct is 288.
 */
export const ShadowUniformLayout = {
  byteLength: 288,
  cascade: {
    byteLength: 112,
    worldToShadowTexture: 0,
    tentSpread: 64,
    fadeStartDistance: 68,
    depthBias: 72,
    fadeEndDistance: 76,
    uvMinimum: 80,
    uvMaximum: 88,
    normalOffsetWorld: 96,
    texelSizeUV: 104,
  },
  near: 0,
  far: 112,
  eyeAndStrength: 224,
  lightDirection: 240,
  tint: 256,
  fadeCenter: 272,
} as const;

function writeCascade(target: Float32Array, base: number, cascade: ShadowCascadeUniform): void {
  const C = ShadowUniformLayout.cascade;
  const matrix = cascade.worldToShadowTexture;
  for (let i = 0; i < 16; i++) target[base + i] = matrix[i]!;
  target[base + C.tentSpread / 4] = cascade.tentSpread;
  target[base + C.fadeStartDistance / 4] = cascade.fadeStartDistance;
  target[base + C.depthBias / 4] = cascade.depthBias;
  target[base + C.fadeEndDistance / 4] = cascade.fadeEndDistance;
  target[base + C.uvMinimum / 4] = cascade.uvMinimum[0];
  target[base + C.uvMinimum / 4 + 1] = cascade.uvMinimum[1];
  target[base + C.uvMaximum / 4] = cascade.uvMaximum[0];
  target[base + C.uvMaximum / 4 + 1] = cascade.uvMaximum[1];
  target[base + C.normalOffsetWorld / 4] = cascade.normalOffsetWorld;
  target[base + C.normalOffsetWorld / 4 + 1] = 0;
  target[base + C.texelSizeUV / 4] = cascade.texelSizeUV[0];
  target[base + C.texelSizeUV / 4 + 1] = cascade.texelSizeUV[1];
}

/** Writes `uniform` into `target` from float `floatOffset` (72 floats). Nothing is allocated. */
export function writeShadowUniform(target: Float32Array, floatOffset: number, uniform: ShadowUniform): void {
  const L = ShadowUniformLayout;
  if (floatOffset < 0 || floatOffset + L.byteLength / 4 > target.length) throw new RangeError(`Shadow uniform does not fit at float ${floatOffset}`);
  writeCascade(target, floatOffset + L.near / 4, uniform.near);
  writeCascade(target, floatOffset + L.far / 4, uniform.far);
  const eye = floatOffset + L.eyeAndStrength / 4;
  target[eye] = uniform.eye[0];
  target[eye + 1] = uniform.eye[1];
  target[eye + 2] = uniform.eye[2];
  target[eye + 3] = uniform.strength;
  const light = floatOffset + L.lightDirection / 4;
  target[light] = uniform.lightDirection[0];
  target[light + 1] = uniform.lightDirection[1];
  target[light + 2] = uniform.lightDirection[2];
  target[light + 3] = 0;
  const tint = floatOffset + L.tint / 4;
  target[tint] = uniform.tint[0];
  target[tint + 1] = uniform.tint[1];
  target[tint + 2] = uniform.tint[2];
  target[tint + 3] = 0;
  const centre = floatOffset + L.fadeCenter / 4;
  target[centre] = uniform.fadeCenter[0];
  target[centre + 1] = uniform.fadeCenter[1];
  target[centre + 2] = 0;
  target[centre + 3] = 0;
}
