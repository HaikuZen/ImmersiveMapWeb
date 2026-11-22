// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2, Vec3 } from "../math/vec.ts";

/**
 * The sphere-to-plane unroll: the CPU mirror of `globeUnrollWorldPosition`
 * in the Swift engine's GlobeUnroll.h, term for term, so markers, labels and
 * scene models sit exactly on the morphing surface. Change only in sync with
 * the shader (its WGSL port).
 *
 * The morph never mixes positions through the planet's interior. The surface
 * lives on a sphere of radius `1 / curvature` tangent to the view centre,
 * with `curvature = (1 - transition) / radius`, and every point travels a
 * straight line in the chart: between its azimuthal-equidistant image about
 * the view centre (arc times bearing, and wrapping that chart back onto the
 * sphere of radius R is the identity) and its Mercator position, with the
 * blended chart point wrapped onto the growing sphere. No direction
 * snapping, so triangles do not fold into slivers. The blend's fold-freedom
 * is swept numerically by the fold test.
 *
 * The `Into` forms write scalars into an output and allocate nothing, for
 * the per-point screen projection.
 */
export const GlobeUnrollMath = {
  /**
   * The unroll's cut as a fraction of the planet radius: a point is hidden
   * while its remaining chart travel exceeds this, and appears only when it
   * is nearly home. At transition 0 the hidden set is exactly the content
   * whose two charts disagree, never visible on the resting sphere. By 1
   * everything has arrived.
   */
  cutTravelFraction: 0.25,

  /**
   * The azimuthal-equidistant image of a sphere position about the view
   * centre, mirroring `globeUnrollChartAE`.
   */
  chartAE(sphereWorldPosition: Vec3, radius: number): Vec2 {
    const out = [0, 0];
    chartAEInto(out, sphereWorldPosition[0], sphereWorldPosition[1], sphereWorldPosition[2], radius);
    return [out[0]!, out[1]!];
  },

  /**
   * Mirror of `globeUnrollCutClearance`: positive once the point's remaining
   * chart travel is short enough to show.
   */
  cutClearance(sphereWorldPosition: Vec3, flatWorldPosition: Vec2, transition: number, radius: number): number {
    return cutClearanceOf(sphereWorldPosition[0], sphereWorldPosition[1], sphereWorldPosition[2], flatWorldPosition[0], flatWorldPosition[1], transition, radius);
  },

  worldPosition(sphereWorldPosition: Vec3, flatWorldPosition: Vec2, transition: number, radius: number): Vec3 {
    const out = [0, 0, 0];
    worldPositionInto(out, sphereWorldPosition[0], sphereWorldPosition[1], sphereWorldPosition[2], flatWorldPosition[0], flatWorldPosition[1], transition, radius);
    return [out[0]!, out[1]!, out[2]!];
  },

  /**
   * Soft visibility of a point against the unrolling sphere: the horizon of
   * the growing sphere the surface lives on. 1 fully visible, 0 hidden behind
   * the (partly unrolled) planet, feathered over a narrow band. By the end of
   * the morph the sphere is a plane and hides nothing.
   */
  horizonAlpha(worldPosition: Vec3, cameraEye: Vec3, transition: number, radius: number): number {
    return horizonAlphaOf(worldPosition[0], worldPosition[1], worldPosition[2], cameraEye, transition, radius);
  },
} as const;

/** `chartAE` written into `out[0..1]`. */
export function chartAEInto(out: number[] | Float64Array, sx: number, sy: number, sz: number, radius: number): void {
  const fromCenterZ = sz + radius;
  const cosTheta = Math.min(Math.max(fromCenterZ / Math.max(radius, 1e-6), -1.0), 1.0);
  const arcSphere = radius * Math.acos(cosTheta);
  const dirSphereLength = Math.hypot(sx, sy);
  if (dirSphereLength > 1e-6) {
    const scale = arcSphere / dirSphereLength;
    out[0] = sx * scale;
    out[1] = sy * scale;
  } else {
    out[0] = 0;
    out[1] = 0;
  }
}

const chartScratch = [0, 0];

/** `cutClearance` on scalars. */
export function cutClearanceOf(sx: number, sy: number, sz: number, fx: number, fy: number, transition: number, radius: number): number {
  chartAEInto(chartScratch, sx, sy, sz, radius);
  const remaining = (1.0 - transition) * Math.hypot(fx - chartScratch[0]!, fy - chartScratch[1]!);
  return GlobeUnrollMath.cutTravelFraction - remaining / Math.max(radius, 1e-6);
}

/** `worldPosition` written into `out[0..2]`. */
export function worldPositionInto(
  out: number[] | Float64Array,
  sx: number,
  sy: number,
  sz: number,
  fx: number,
  fy: number,
  transition: number,
  radius: number,
): void {
  const curvature = (1.0 - transition) / Math.max(radius, 1e-6);
  if (curvature <= 1e-9) {
    out[0] = fx;
    out[1] = fy;
    out[2] = 0.0;
    return;
  }
  chartAEInto(chartScratch, sx, sy, sz, radius);
  const aeX = chartScratch[0]!;
  const aeY = chartScratch[1]!;
  const chartX = aeX + (fx - aeX) * transition;
  const chartY = aeY + (fy - aeY) * transition;
  const arc = Math.hypot(chartX, chartY);
  if (arc <= 1e-6) {
    out[0] = chartX;
    out[1] = chartY;
    out[2] = 0.0;
    return;
  }
  const angle = arc * curvature;
  const rho = Math.sin(angle) / curvature;
  const sag = (Math.cos(angle) - 1.0) / curvature;
  out[0] = (chartX / arc) * rho;
  out[1] = (chartY / arc) * rho;
  out[2] = sag;
}

/** `horizonAlpha` on scalars. */
export function horizonAlphaOf(wx: number, wy: number, wz: number, cameraEye: Vec3, transition: number, radius: number): number {
  const curvature = (1.0 - transition) / Math.max(radius, 1e-6);
  if (!(curvature > 1e-9)) {
    return 1.0;
  }
  const unrollRadius = 1.0 / curvature;
  // center = (0, 0, -unrollRadius)
  const toEyeX = cameraEye[0];
  const toEyeY = cameraEye[1];
  const toEyeZ = cameraEye[2] + unrollRadius;
  const toEyeLength = Math.sqrt(toEyeX * toEyeX + toEyeY * toEyeY + toEyeZ * toEyeZ);
  const normalization = Math.max(toEyeLength * unrollRadius, 1e-6);
  const normalizedDot = (wx * toEyeX + wy * toEyeY + (wz + unrollRadius) * toEyeZ) / normalization;
  const threshold = (unrollRadius * unrollRadius) / normalization;
  const delta = normalizedDot - threshold;
  const band = 0.03;
  const t = Math.min(Math.max((delta + band) / (2.0 * band), 0.0), 1.0);
  return t * t * (3.0 - 2.0 * t);
}
