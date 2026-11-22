// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../math/matrix.ts";
import { mat4Invert } from "../math/mat4-invert.ts";

/**
 * The ground shadow mask, a port of the Swift `GroundShadowMaskPipeline`
 * constants and `GroundShadowMaskUniform`: one 8-bit shadow factor of the
 * ground plane per mask pixel, written by a fullscreen pass that samples the
 * shadow windows once, and read by every flat ground layer instead of
 * sampling the windows in each.
 */
export const GroundShadowMask = {
  format: "r8unorm" as GPUTextureFormat,
  /**
   * Mask pixels per drawable pixel. The shadow edge is already a two-texel
   * ramp of a window whose texel spans several screen pixels at a street
   * zoom, so a bilinear upsample of a smaller mask reads the same and the
   * pass costs a fraction of the fragments. Mirrored by the ground shaders,
   * where the pixel position turns into mask UV.
   */
  resolutionScale: 0.4,
  /** The mask's size for a drawable, rounded up so the mask always covers it. */
  maskSize(width: number, height: number): [number, number] {
    return [Math.ceil(width * GroundShadowMask.resolutionScale), Math.ceil(height * GroundShadowMask.resolutionScale)];
  },
} as const;

/**
 * The mask pass's uniform, `GroundShadowMaskUniform` in its WGSL:
 *
 * ```wgsl
 * struct GroundShadowMaskUniform {
 *   inverseProjectionView: mat4x4f, // 0
 *   viewportSize: vec2f,            // 64
 *   padding: vec2f,                 // 72
 * }                                 // 80
 * ```
 */
export const GroundShadowMaskUniformLayout = {
  byteLength: 80,
  inverseProjectionView: 0,
  viewportSize: 64,
} as const;

const inverseScratch: Mat4 = new Float64Array(16);

/**
 * Writes the mask pass's uniform into `target` (20 floats) from float 0: the
 * inverse of the CPU projection-view, inverted in double precision, and the
 * mask's size in pixels. False when the matrix has no inverse: the frame
 * then has no mask.
 */
export function writeGroundShadowMaskUniform(target: Float32Array, projectionView: Mat4, viewportWidth: number, viewportHeight: number): boolean {
  if (!mat4Invert(inverseScratch, projectionView)) return false;
  for (let i = 0; i < 16; i++) target[i] = inverseScratch[i]!;
  target[16] = viewportWidth;
  target[17] = viewportHeight;
  target[18] = 0;
  target[19] = 0;
  return true;
}
