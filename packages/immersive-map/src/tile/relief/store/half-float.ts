// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Half floats by their bits, as the terrain's heights are kept (an
 * `r16float` texture for the GPU and the same bits on the CPU). The
 * conversion to bits rounds to the nearest, ties to even, as the Swift
 * engine's `vImageConvert_PlanarFtoPlanar16F` and the worker's decoder
 * (`crates/ground-relief`) do.
 */

/** Every half float's value by its bits: one lookup where the CPU reads a height. */
const halfValues = (() => {
  const values = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits++) values[bits] = halfBitsToFloatSlow(bits);
  return values;
})();

function halfBitsToFloatSlow(bits: number): number {
  const negative = (bits & 0x8000) !== 0;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) {
    // A subnormal, or zero: the mantissa over 2^24.
    const value = mantissa * 5.960464477539063e-8;
    return negative ? -value : value;
  }
  if (exponent === 0x1f) {
    if (mantissa !== 0) return Number.NaN;
    return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const value = 2 ** (exponent - 15) * (1 + mantissa / 1024);
  return negative ? -value : value;
}

/** A half float's value, by its bits (the Swift `GroundReliefTile.float(halfBits:)`). */
export function halfBitsToFloat(bits: number): number {
  return halfValues[bits & 0xffff]!;
}

const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

/** The bits of the half float nearest a value, ties to even, past the largest half to infinity. */
export function floatToHalfBits(value: number): number {
  scratch[0] = value;
  const bits = scratchBits[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  let halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    // A subnormal half, or zero.
    if (halfExponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - halfExponent;
    let half = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
    return sign | half;
  }
  let half = (halfExponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half += 1;
  // A carry out of the mantissa steps the exponent, up to infinity.
  halfExponent = half >>> 10;
  return sign | (halfExponent >= 0x1f ? 0x7c00 : half);
}

/** Floats as half floats. */
export function halves(values: ArrayLike<number>): Uint16Array<ArrayBuffer> {
  const result = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index++) result[index] = floatToHalfBits(values[index]!);
  return result;
}
