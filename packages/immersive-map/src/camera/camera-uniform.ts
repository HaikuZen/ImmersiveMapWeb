// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Mat4, mat4Multiply } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";
import { RenderCamera } from "./render-camera.ts";

/**
 * The camera as the GPU reads it: the matrix it draws with and the eye in
 * render world units. The CPU-side value, for code that mirrors the shaders
 * (`GeoScreenProjectionMath`). `writeCameraUniform` lays it out for a
 * uniform buffer.
 */
export interface CameraUniform {
  readonly matrix: Mat4;
  readonly eye: Vec3;
}

/**
 * The byte length of the camera uniform: 80 bytes.
 *
 * The layout is WGSL's natural one for
 *
 * ```wgsl
 * struct CameraUniform {
 *   matrix: mat4x4<f32>, // offset 0, 64 bytes, column-major
 *   eye: vec3<f32>,      // offset 64, 12 bytes
 *   padding: f32,        // offset 76, 4 bytes, written as 0
 * }
 * ```
 *
 * The struct's alignment is 16 and its size 80. The Swift engine's Metal
 * struct is the same fields, but MSL's `float3` takes 16 bytes, which puts
 * its padding at 80 and makes it 96 bytes long. WGSL's `vec3<f32>` takes 12,
 * so the padding sits in the vector's tail here.
 */
export const CAMERA_UNIFORM_BYTE_LENGTH = 80;

/**
 * Writes `matrix` (rounded to f32, column-major) and `eye` into `target` at
 * `byteOffset` (counted from the start of `target`, a multiple of 4) in the
 * layout of `CAMERA_UNIFORM_BYTE_LENGTH`. `target` is the uniform's staging
 * memory, in the platform's byte order, which is little-endian wherever
 * WebGPU runs. Nothing is allocated.
 */
export function writeCameraUniform(target: Float32Array, byteOffset: number, matrix: Mat4, eye: Vec3): void {
  const base = byteOffset / 4;
  if (!Number.isInteger(base) || base < 0 || base + 20 > target.length) {
    throw new RangeError(`Camera uniform does not fit at byte offset ${byteOffset}`);
  }
  for (let index = 0; index < 16; index++) {
    target[base + index] = matrix[index]!;
  }
  target[base + 16] = eye[0];
  target[base + 17] = eye[1];
  target[base + 18] = eye[2];
  target[base + 19] = 0;
}

const gpuMatrixScratch: Mat4 = new Float64Array(16);

/**
 * The uniform the GPU draws with (Swift `FrameContext.cameraUniform`): the
 * CPU projection-view with its clip z moved to the GPU far plane and scaled
 * for the real geometry (`RenderCamera.gpuClipDepthAdjustment`), which the
 * CPU's own matrices never carry, and the eye. Written like
 * `writeCameraUniform`, with no allocation.
 */
export function writeGpuCameraUniform(target: Float32Array, byteOffset: number, projectionView: Mat4, eye: Vec3): void {
  mat4Multiply(gpuMatrixScratch, RenderCamera.gpuClipDepthAdjustment, projectionView);
  writeCameraUniform(target, byteOffset, gpuMatrixScratch, eye);
}
