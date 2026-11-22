// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";
import type { HorizonHaze } from "./horizon-frame-resolver.ts";

/**
 * Per-frame parameters of the horizon layer, the Swift `HorizonUniform`: the
 * values `HorizonFrameResolver` resolved, in the GPU shape of `Horizon` in
 * horizon.wgsl. WGSL's `vec3f` takes 12 bytes, so each scalar that follows a
 * vector fills its tail (MSL's `float3` takes 16, which is why the Swift
 * offsets differ). The band's top sits beside the sky's gradient, ahead of
 * the matrix, where the Metal struct has it after.
 */
export const HorizonUniformLayout = {
  up: 0,
  depression: 12,
  center: 16,
  sunInfluence: 28,
  light: 32,
  skyStrength: 44,
  tint: 48,
  whitenWeight: 60,
  eye: 64,
  featherStrength: 76,
  bandRadians: 80,
  glowRadians: 84,
  whitenRadians: 88,
  featherRadians: 92,
  groundBandRadians: 96,
  groundGain: 100,
  cutoffStartRadians: 104,
  cutoffEndRadians: 108,
  skyColor: 112,
  skyOpacity: 124,
  skyGradientRadians: 128,
  bandTopRadians: 132,
  viewProjection: 144,
  byteLength: 208,
} as const;

/** Writes the haze into `target` (the uniform's staging, `byteLength / 4` floats). Nothing is allocated. */
export function writeHorizonUniform(target: Float32Array, haze: HorizonHaze, projectionView: Mat4, cameraEye: Vec3): void {
  const L = HorizonUniformLayout;
  const vec3 = (offset: number, v: Vec3, w: number): void => {
    const i = offset / 4;
    target[i] = v[0];
    target[i + 1] = v[1];
    target[i + 2] = v[2];
    target[i + 3] = w;
  };
  vec3(L.up, haze.edge.up, haze.edge.depression);
  vec3(L.center, haze.center, haze.sunInfluence);
  vec3(L.light, haze.light, haze.skyStrength);
  vec3(L.tint, haze.tint, haze.whitenWeight);
  vec3(L.eye, cameraEye, haze.featherStrength);
  target[L.bandRadians / 4] = haze.bandRadians;
  target[L.glowRadians / 4] = haze.glowRadians;
  target[L.whitenRadians / 4] = haze.whitenRadians;
  target[L.featherRadians / 4] = haze.featherRadians;
  target[L.groundBandRadians / 4] = haze.groundBandRadians;
  target[L.groundGain / 4] = haze.groundGain;
  target[L.cutoffStartRadians / 4] = haze.cutoffStartRadians;
  target[L.cutoffEndRadians / 4] = haze.cutoffEndRadians;
  vec3(L.skyColor, haze.skyColor, haze.skyOpacity);
  target[L.skyGradientRadians / 4] = haze.skyGradientRadians;
  target[L.bandTopRadians / 4] = haze.bandTopRadians;
  target[L.bandTopRadians / 4 + 1] = 0;
  target[L.bandTopRadians / 4 + 2] = 0;
  for (let i = 0; i < 16; i++) target[L.viewProjection / 4 + i] = projectionView[i]!;
}
