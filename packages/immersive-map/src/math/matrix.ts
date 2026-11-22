// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec3, Vec4 } from "./vec.ts";

/**
 * A 4x4 matrix stored column-major, as simd's `matrix_float4x4` is: element
 * `m[column * 4 + row]`, so simd's `matrix[c][r]` is `m[c * 4 + r]` and
 * `matrix.columns.c.x` is `m[c * 4]`. A `Float64Array` keeps the CPU math in
 * double precision. A uniform rounds it to `f32` once, when it is written
 * (`writeCameraUniform`).
 */
export type Mat4 = Float64Array;

/** A new identity matrix. */
export function mat4Identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** A new matrix from its four columns. */
export function mat4FromColumns(c0: Vec4, c1: Vec4, c2: Vec4, c3: Vec4): Mat4 {
  return Float64Array.of(...c0, ...c1, ...c2, ...c3);
}

/** Writes the identity into `out` and returns it. */
export function mat4SetIdentity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function mat4Copy(out: Mat4, source: Mat4): Mat4 {
  out.set(source);
  return out;
}

/**
 * `out = a * b`, the simd product (b applied first). `out` may alias `a` or
 * `b`: the product is accumulated in locals before it is stored.
 */
export function mat4Multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;
  for (let column = 0; column < 4; column++) {
    const base = column * 4;
    const b0 = b[base]!, b1 = b[base + 1]!, b2 = b[base + 2]!, b3 = b[base + 3]!;
    out[base] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[base + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[base + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[base + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

/** `simd_transpose` into `out`. `out` may alias `m`. */
export function mat4Transpose(out: Mat4, m: Mat4): Mat4 {
  const m01 = m[1]!, m02 = m[2]!, m03 = m[3]!, m12 = m[6]!, m13 = m[7]!, m23 = m[11]!;
  out[0] = m[0]!;
  out[1] = m[4]!;
  out[2] = m[8]!;
  out[3] = m[12]!;
  out[4] = m01;
  out[5] = m[5]!;
  out[6] = m[9]!;
  out[7] = m[13]!;
  out[8] = m02;
  out[9] = m12;
  out[10] = m[10]!;
  out[11] = m[14]!;
  out[12] = m03;
  out[13] = m13;
  out[14] = m23;
  out[15] = m[15]!;
  return out;
}

/**
 * `m * (x, y, z, w)` written into `out[0..3]`. The scalar form the per-frame
 * paths use, with no vector built per call.
 */
export function mat4TransformInto(out: Float64Array | number[], m: Mat4, x: number, y: number, z: number, w: number): void {
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w;
  out[3] = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w;
}

/** `m * v`, allocating the result. For code off the per-frame paths and for tests. */
export function mat4TransformVec4(m: Mat4, v: Vec4): Vec4 {
  const out = [0, 0, 0, 0];
  mat4TransformInto(out, m, v[0], v[1], v[2], v[3]);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/**
 * The matrix builders of the Swift `Matrix` class. Each writes into `out`
 * and returns it, so a caller that keeps a matrix per frame reuses it.
 */
export const Matrix = {
  /**
   * Orthographic projection with the Metal (and WebGPU) depth convention:
   * view-space `z = -near` maps to NDC 0 and `z = -far` to NDC 1.
   *
   * The legacy `orthographicMatrix` below is GL-convention (NDC depth
   * [-1, 1]). Its callers only rasterize `z = 0` content, so the difference
   * never shows there, but geometry spanning a depth range (the shadow map)
   * would lose the near half of the volume to a [0, 1] clip.
   */
  metalOrthographicMatrix(out: Mat4, left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
    const rml = right - left;
    const tmb = top - bottom;
    const fmn = far - near;
    out.fill(0);
    out[0] = 2 / rml;
    out[5] = 2 / tmb;
    out[10] = -1 / fmn;
    out[12] = -(right + left) / rml;
    out[13] = -(top + bottom) / tmb;
    out[14] = -near / fmn;
    out[15] = 1;
    return out;
  },

  orthographicMatrix(out: Mat4, left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
    const rml = right - left;
    const tmb = top - bottom;
    const fmn = far - near;
    out.fill(0);
    out[0] = 2 / rml;
    out[5] = 2 / tmb;
    out[10] = -2 / fmn;
    out[12] = -(right + left) / rml;
    out[13] = -(top + bottom) / tmb;
    out[14] = -(far + near) / fmn;
    out[15] = 1;
    return out;
  },

  /**
   * The perspective of the render camera. Its z row is the GL form
   * (`-(far + near) / (far - near)`, `-2 far near / (far - near)`), exactly
   * as the Swift engine builds it. The frustum and the GPU depth adjustment
   * (`RenderCamera.gpuClipDepthAdjustment`) are written against this form.
   */
  perspectiveMatrix(out: Mat4, fovRadians: number, aspect: number, near: number, far: number): Mat4 {
    const yScale = 1 / Math.tan(fovRadians * 0.5);
    const xScale = yScale / aspect;
    const zRange = far - near;
    const zScale = -(far + near) / zRange;
    const wzScale = (-2 * far * near) / zRange;
    out.fill(0);
    out[0] = xScale;
    out[5] = yScale;
    out[10] = zScale;
    out[11] = -1;
    out[14] = wzScale;
    return out;
  },

  scaleMatrix(out: Mat4, sx: number, sy: number, sz: number): Mat4 {
    mat4SetIdentity(out);
    out[0] = sx;
    out[5] = sy;
    out[10] = sz;
    return out;
  },

  /** A translation matrix. */
  translationMatrix(out: Mat4, x: number, y: number, z: number): Mat4 {
    mat4SetIdentity(out);
    out[12] = x;
    out[13] = y;
    out[14] = z;
    return out;
  },

  /** A rotation matrix around the x-axis. */
  rotationMatrixX(out: Mat4, radians: number): Mat4 {
    mat4SetIdentity(out);
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    out[5] = c;
    out[6] = s;
    out[9] = -s;
    out[10] = c;
    return out;
  },

  /** A rotation matrix around the y-axis. */
  rotationMatrixY(out: Mat4, radians: number): Mat4 {
    mat4SetIdentity(out);
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    out[0] = c;
    out[2] = -s;
    out[8] = s;
    out[10] = c;
    return out;
  },

  /** A rotation matrix around the z-axis. */
  rotationMatrixZ(out: Mat4, radians: number): Mat4 {
    mat4SetIdentity(out);
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    out[0] = c;
    out[1] = s;
    out[4] = -s;
    out[5] = c;
    return out;
  },

  /** A look-at view matrix. */
  lookAt(out: Mat4, eye: Vec3, center: Vec3, up: Vec3): Mat4 {
    // f = normalize(center - eye)
    let fx = center[0] - eye[0];
    let fy = center[1] - eye[1];
    let fz = center[2] - eye[2];
    const fLength = 1 / Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx *= fLength;
    fy *= fLength;
    fz *= fLength;
    // s = normalize(cross(f, up))
    let sx = fy * up[2] - fz * up[1];
    let sy = fz * up[0] - fx * up[2];
    let sz = fx * up[1] - fy * up[0];
    const sLength = 1 / Math.sqrt(sx * sx + sy * sy + sz * sz);
    sx *= sLength;
    sy *= sLength;
    sz *= sLength;
    // u = cross(s, f)
    const ux = sy * fz - sz * fy;
    const uy = sz * fx - sx * fz;
    const uz = sx * fy - sy * fx;

    out[0] = sx;
    out[1] = ux;
    out[2] = -fx;
    out[3] = 0;
    out[4] = sy;
    out[5] = uy;
    out[6] = -fy;
    out[7] = 0;
    out[8] = sz;
    out[9] = uz;
    out[10] = -fz;
    out[11] = 0;
    out[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
    out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    out[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
    out[15] = 1;
    return out;
  },
} as const;
