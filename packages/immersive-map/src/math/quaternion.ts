// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "./matrix.ts";
import type { Vec3 } from "./vec.ts";

/**
 * A rotation quaternion, the stand-in for simd's `simd_quatf`. The layout is
 * simd's `vector`: the imaginary part first, the real part last
 * (`[ix, iy, iz, r]`). Like the rest of the CPU math it is computed in
 * double precision.
 */
export type Quat = readonly [ix: number, iy: number, iz: number, r: number];

export const QUAT_IDENTITY: Quat = Object.freeze([0, 0, 0, 1] as const);

/** `simd_quatf(angle:axis:)`: a turn of `angle` radians about `axis` (normalized here). */
export function quatFromAngleAxis(angle: number, axis: Vec3): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const half = angle * 0.5;
  const s = length > 0 ? Math.sin(half) / length : 0;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** `a * b`, the simd product: `b` turns first, then `a`. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function quatLength(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

export function quatNormalize(q: Quat): Quat {
  const inverse = 1 / quatLength(q);
  return [q[0] * inverse, q[1] * inverse, q[2] * inverse, q[3] * inverse];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** `simd_act`: the vector turned by the quaternion. */
export function quatAct(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v), v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(x) / x;
}

/**
 * `simd_slerp`: spherical interpolation along the shorter arc. When the two
 * quaternions lie in opposite hemispheres the target is negated first, so
 * the turn never goes the long way round. The angle comes from `atan2` of
 * the chord lengths (as simd computes it), which stays accurate for nearly
 * equal rotations where `acos` of the dot product would not.
 */
export function quatSlerp(from: Quat, to: Quat, t: number): Quat {
  const target: Quat = quatDot(from, to) >= 0 ? to : [-to[0], -to[1], -to[2], -to[3]];
  const difference = Math.hypot(from[0] - target[0], from[1] - target[1], from[2] - target[2], from[3] - target[3]);
  const sum = Math.hypot(from[0] + target[0], from[1] + target[1], from[2] + target[2], from[3] + target[3]);
  const angle = 2 * Math.atan2(difference, sum);
  const s = 1 - t;
  const reciprocal = 1 / sinc(angle);
  const fromWeight = sinc(s * angle) * reciprocal * s;
  const toWeight = sinc(t * angle) * reciprocal * t;
  return quatNormalize([
    from[0] * fromWeight + target[0] * toWeight,
    from[1] * fromWeight + target[1] * toWeight,
    from[2] * fromWeight + target[2] * toWeight,
    from[3] * fromWeight + target[3] * toWeight,
  ]);
}

/**
 * `simd_float3x3(quaternion)`: the rotation matrix, column-major, element
 * `m[column * 3 + row]`. The quaternion is normalized first.
 */
export function quatToMat3(q: Quat): Float64Array {
  const [x, y, z, w] = quatNormalize(q);
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return Float64Array.of(
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
  );
}

/** `matrix_float4x4(quaternion)`: the rotation as a 4x4 matrix written into `out`. */
export function quatToMat4(out: Mat4, q: Quat): Mat4 {
  const m = quatToMat3(q);
  out[0] = m[0]!;
  out[1] = m[1]!;
  out[2] = m[2]!;
  out[3] = 0;
  out[4] = m[3]!;
  out[5] = m[4]!;
  out[6] = m[5]!;
  out[7] = 0;
  out[8] = m[6]!;
  out[9] = m[7]!;
  out[10] = m[8]!;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}
