// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "./matrix.ts";

/** The inverse of a column-major 4x4 matrix into `out`, false when it is singular. */
export function mat4Invert(out: Mat4, m: Mat4): boolean {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[] as [
    number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number,
  ];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return false;
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}
