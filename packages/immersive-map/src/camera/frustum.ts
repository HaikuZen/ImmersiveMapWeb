// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../math/matrix.ts";

/**
 * The six planes of a projection-view matrix, for culling. The planes are
 * stored as `(a, b, c, d)` quadruples in one `Float64Array(24)`, in the
 * order left, right, bottom, top, near, far, each normalized so
 * `a x + b y + c z + d` is a signed distance. `update` rewrites them in
 * place, so a frustum kept by the camera allocates nothing per frame.
 */
export class Frustum {
  readonly planes = new Float64Array(24);

  constructor(pv?: Mat4) {
    if (pv !== undefined) {
      this.update(pv);
    }
  }

  /**
   * Extracts the planes using Gribb-Hartmann adjusted for a 0 to 1 depth
   * buffer (Metal and WebGPU): the near plane is the matrix's z row alone.
   */
  update(pv: Mat4): void {
    const m0x = pv[0]!, m0y = pv[1]!, m0z = pv[2]!, m0w = pv[3]!;
    const m1x = pv[4]!, m1y = pv[5]!, m1z = pv[6]!, m1w = pv[7]!;
    const m2x = pv[8]!, m2y = pv[9]!, m2z = pv[10]!, m2w = pv[11]!;
    const m3x = pv[12]!, m3y = pv[13]!, m3z = pv[14]!, m3w = pv[15]!;
    this.setPlane(0, m0w + m0x, m1w + m1x, m2w + m2x, m3w + m3x);
    this.setPlane(1, m0w - m0x, m1w - m1x, m2w - m2x, m3w - m3x);
    this.setPlane(2, m0w + m0y, m1w + m1y, m2w + m2y, m3w + m3y);
    this.setPlane(3, m0w - m0y, m1w - m1y, m2w - m2y, m3w - m3y);
    this.setPlane(4, m0z, m1z, m2z, m3z);
    this.setPlane(5, m0w - m0z, m1w - m1z, m2w - m2z, m3w - m3z);
  }

  private setPlane(index: number, a: number, b: number, c: number, d: number): void {
    const inverseLength = 1 / Math.sqrt(a * a + b * b + c * c);
    const base = index * 4;
    this.planes[base] = a * inverseLength;
    this.planes[base + 1] = b * inverseLength;
    this.planes[base + 2] = c * inverseLength;
    this.planes[base + 3] = d * inverseLength;
  }

  /** Whether the axis-aligned box from `min` to `max` (x, y, z read) is at least partly inside. */
  isBoxVisible(min: ArrayLike<number>, max: ArrayLike<number>): boolean {
    return this.isBoxVisibleXYZ(min[0]!, min[1]!, min[2]!, max[0]!, max[1]!, max[2]!);
  }

  isBoxVisibleXYZ(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    const planes = this.planes;
    for (let base = 0; base < 24; base += 4) {
      const a = planes[base]!, b = planes[base + 1]!, c = planes[base + 2]!, d = planes[base + 3]!;
      const px = a >= 0 ? maxX : minX;
      const py = b >= 0 ? maxY : minY;
      const pz = c >= 0 ? maxZ : minZ;
      if (a * px + b * py + c * pz + d < 0) {
        return false;
      }
    }
    return true;
  }

  isSphereVisible(center: ArrayLike<number>, radius: number): boolean {
    const planes = this.planes;
    const x = center[0]!, y = center[1]!, z = center[2]!;
    for (let base = 0; base < 24; base += 4) {
      const distance = planes[base]! * x + planes[base + 1]! * y + planes[base + 2]! * z + planes[base + 3]!;
      if (distance < -radius) {
        return false;
      }
    }
    return true;
  }

  containsSphere(center: ArrayLike<number>, radius: number): boolean {
    const planes = this.planes;
    const x = center[0]!, y = center[1]!, z = center[2]!;
    for (let base = 0; base < 24; base += 4) {
      const distance = planes[base]! * x + planes[base + 1]! * y + planes[base + 2]! * z + planes[base + 3]!;
      if (distance < radius) {
        return false;
      }
    }
    return true;
  }
}
