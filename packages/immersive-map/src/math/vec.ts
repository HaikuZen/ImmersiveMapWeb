// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Small immutable vectors, the stand-ins for simd's `SIMD2`, `SIMD3` and
 * `SIMD4`. They are plain tuples, so a value is cheap to build and to
 * compare, and every operation returns a new one. The per-frame paths
 * (the camera matrices, the frustum, the screen projection) do not go
 * through them: they work on scalars and write into preallocated outputs.
 *
 * Every component is a `number` (a double). The Swift engine keeps its
 * camera math in `Float`, and the port computes it in double precision:
 * the results agree to well within the tolerances the tests pin, and the
 * GPU side rounds to `f32` once, when a uniform is written.
 */

export type Vec2 = readonly [x: number, y: number];
export type Vec3 = readonly [x: number, y: number, z: number];
export type Vec4 = readonly [x: number, y: number, z: number, w: number];

export function vec2(x: number, y: number): Vec2 {
  return [x, y];
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function vec4(x: number, y: number, z: number, w: number): Vec4 {
  return [x, y, z, w];
}

export const VEC2_ZERO: Vec2 = Object.freeze([0, 0] as const);
export const VEC3_ZERO: Vec3 = Object.freeze([0, 0, 0] as const);

// MARK: - Vec2

export function add2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function scale2(a: Vec2, s: number): Vec2 {
  return [a[0] * s, a[1] * s];
}

export function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function length2(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function equals2(a: Vec2, b: Vec2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// MARK: - Vec3

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length3(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** simd_normalize: the vector over its length (NaN for the zero vector, as in simd). */
export function normalize3(a: Vec3): Vec3 {
  const inverse = 1 / length3(a);
  return [a[0] * inverse, a[1] * inverse, a[2] * inverse];
}

/** `from + (to - from) * t`. */
export function mix3(from: Vec3, to: Vec3, t: number): Vec3 {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

export function equals3(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// MARK: - Scalars

/** `simd_clamp` for a scalar. */
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

/** The Hermite smoothstep of an already clamped `t` in [0, 1]. */
export function smoothstepUnit(t: number): number {
  return t * t * (3 - 2 * t);
}
