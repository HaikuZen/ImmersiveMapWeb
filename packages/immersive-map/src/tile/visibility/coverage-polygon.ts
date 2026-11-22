// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../../math/matrix.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { Vec2 } from "../../math/vec.ts";

/** The tolerance of the footprint's plane cuts and polygon tests, in world units. */
const planeIntersectionTolerance = 1e-5;
/** `Float.ulpOfOne`: the edges the Swift engine treats as level in its slab test. */
const levelEdgeTolerance = 1.1920928955078125e-7;

/** The axis-aligned bounds of a polygon. */
export interface CoverageBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Scratch for the slab test, so `intersects` (asked for every tile the walk visits) allocates nothing. */
const slabScratch = new Float64Array(2);

/** The convex footprint of the frustum on the flat plane, in world units. */
export class CoveragePolygon {
  readonly vertices: readonly Vec2[];
  readonly bounds: CoverageBounds;

  constructor(vertices: readonly Vec2[]) {
    this.vertices = vertices;
    let minX = vertices[0]?.[0] ?? 0;
    let maxX = minX;
    let minY = vertices[0]?.[1] ?? 0;
    let maxY = minY;
    for (let index = 1; index < vertices.length; index++) {
      const vertex = vertices[index]!;
      minX = Math.min(minX, vertex[0]);
      maxX = Math.max(maxX, vertex[0]);
      minY = Math.min(minY, vertex[1]);
      maxY = Math.max(maxY, vertex[1]);
    }
    this.bounds = { minX, maxX, minY, maxY };
  }

  /**
   * The polygon scaled about a point by `factor`: the footprint pushed out
   * from the camera's ground point, which is what the far texture bands are
   * asked for ahead of a turn (`CoverageSettings.rasterBandMarginShare`).
   * Convex stays convex, and the winding is kept.
   */
  inflated(centerX: number, centerY: number, factor: number): CoveragePolygon {
    if (factor === 1) return this;
    return new CoveragePolygon(this.vertices.map((v): Vec2 => [centerX + (v[0] - centerX) * factor, centerY + (v[1] - centerY) * factor]));
  }

  /** Twice the signed area: the sign is the winding, which the clipping against the polygon's edges needs. */
  get signedArea(): number {
    const vertices = this.vertices;
    let area = 0;
    for (let index = 0; index < vertices.length; index++) {
      const start = vertices[index]!;
      const end = vertices[(index + 1) % vertices.length]!;
      area += start[0] * end[1] - end[0] * start[1];
    }
    return area;
  }

  /**
   * Whether the polygon meets an axis-aligned square of the plane: the
   * polygon is convex, so its cut with the square's horizontal band is one x
   * interval, and the square meets it exactly when that interval overlaps
   * the square's own.
   */
  intersects(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const tolerance = planeIntersectionTolerance;
    const bounds = this.bounds;
    if (bounds.maxX < minX - tolerance || bounds.minX > maxX + tolerance || bounds.maxY < minY - tolerance || bounds.minY > maxY + tolerance) {
      return false;
    }
    if (!this.slabXRangeInto(minY - tolerance, maxY + tolerance, slabScratch)) return false;
    return slabScratch[0]! <= maxX + tolerance && slabScratch[1]! >= minX - tolerance;
  }

  /**
   * The polygon cut by a line, keeping the side `inside` lies on
   * (Sutherland-Hodgman against one half-plane). `undefined` when nothing of
   * it is left, or too little to have an area.
   */
  clipped(inside: Vec2, a: Vec2, b: Vec2): CoveragePolygon | undefined {
    const edgeX = b[0] - a[0];
    const edgeY = b[1] - a[1];
    const side = (x: number, y: number) => edgeX * (y - a[1]) - edgeY * (x - a[0]);
    const insideSide = side(inside[0], inside[1]);
    if (!(Math.abs(insideSide) > 1e-18)) return this;
    const orientation = insideSide > 0 ? 1.0 : -1.0;
    const points = this.vertices;
    const clipped: Vec2[] = [];
    for (let index = 0; index < points.length; index++) {
      const current = points[index]!;
      const previous = points[(index + points.length - 1) % points.length]!;
      const currentInside = orientation * side(current[0], current[1]) >= 0;
      const previousInside = orientation * side(previous[0], previous[1]) >= 0;
      if (currentInside) {
        if (!previousInside) clipped.push(CoveragePolygon.intersection(previous, current, a, b));
        clipped.push(current);
      } else if (previousInside) {
        clipped.push(CoveragePolygon.intersection(previous, current, a, b));
      }
    }
    if (clipped.length < 3) return undefined;
    const polygon = new CoveragePolygon(clipped);
    if (!(Math.abs(polygon.signedArea) > planeIntersectionTolerance)) return undefined;
    return polygon;
  }

  /** Where the segment from `a` to `b` crosses the line through `c` and `d`. */
  static intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 {
    const abX = b[0] - a[0];
    const abY = b[1] - a[1];
    const cdX = d[0] - c[0];
    const cdY = d[1] - c[1];
    const denominator = abX * cdY - abY * cdX;
    if (!(Math.abs(denominator) > 1e-18)) return a;
    const t = ((c[0] - a[0]) * cdY - (c[1] - a[1]) * cdX) / denominator;
    return [a[0] + abX * t, a[1] + abY * t];
  }

  /**
   * The x interval of the convex polygon's cut with a horizontal band. The
   * cut is a convex region whose x extrema lie at the polygon's vertices
   * inside the band or where its edges cross the band's boundaries, so no
   * interior point needs to be enumerated.
   */
  horizontalSlabXRange(slabMinY: number, slabMaxY: number): ClosedRange | undefined {
    const out = new Float64Array(2);
    return this.slabXRangeInto(slabMinY, slabMaxY, out) ? { lowerBound: out[0]!, upperBound: out[1]! } : undefined;
  }

  /** `horizontalSlabXRange` written into `out`, false where the band misses the polygon. */
  private slabXRangeInto(slabMinY: number, slabMaxY: number, out: Float64Array): boolean {
    const vertices = this.vertices;
    let lowestX = Number.POSITIVE_INFINITY;
    let highestX = Number.NEGATIVE_INFINITY;
    let hasIntersection = false;
    for (let index = 0; index < vertices.length; index++) {
      const start = vertices[index]!;
      const end = vertices[(index + 1) % vertices.length]!;
      const startX = start[0];
      const startY = start[1];
      if (startY >= slabMinY && startY <= slabMaxY) {
        lowestX = Math.min(lowestX, startX);
        highestX = Math.max(highestX, startX);
        hasIntersection = true;
      }
      const deltaY = end[1] - startY;
      if (!(Math.abs(deltaY) > levelEdgeTolerance)) continue;
      const deltaX = end[0] - startX;
      const tAtMinY = (slabMinY - startY) / deltaY;
      if (tAtMinY >= 0 && tAtMinY <= 1) {
        const x = startX + deltaX * tAtMinY;
        lowestX = Math.min(lowestX, x);
        highestX = Math.max(highestX, x);
        hasIntersection = true;
      }
      const tAtMaxY = (slabMaxY - startY) / deltaY;
      if (tAtMaxY >= 0 && tAtMaxY <= 1) {
        const x = startX + deltaX * tAtMaxY;
        lowestX = Math.min(lowestX, x);
        highestX = Math.max(highestX, x);
        hasIntersection = true;
      }
    }
    out[0] = lowestX;
    out[1] = highestX;
    return hasIntersection;
  }
}

const clipSpaceCorners: readonly (readonly [number, number, number])[] = [
  [-1, -1, 0],
  [1, -1, 0],
  [1, 1, 0],
  [-1, 1, 0],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

const frustumEdges: readonly (readonly [start: number, end: number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

type Point3 = readonly [number, number, number];

/** The inverse of a column-major 4x4 matrix into `out`, false for a singular one. */
function invertInto(out: Float64Array, m: Mat4): boolean {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
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
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (determinant === 0 || !Number.isFinite(determinant)) return false;
  const inverse = 1 / determinant;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inverse;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inverse;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inverse;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inverse;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inverse;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inverse;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inverse;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inverse;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inverse;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inverse;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inverse;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inverse;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inverse;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inverse;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inverse;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inverse;
  return true;
}

const inverseScratch = new Float64Array(16);

function unprojectClipSpacePoint(point: Point3, inverse: Float64Array): Point3 | undefined {
  const [x, y, z] = point;
  const hx = inverse[0]! * x + inverse[4]! * y + inverse[8]! * z + inverse[12]!;
  const hy = inverse[1]! * x + inverse[5]! * y + inverse[9]! * z + inverse[13]!;
  const hz = inverse[2]! * x + inverse[6]! * y + inverse[10]! * z + inverse[14]!;
  const hw = inverse[3]! * x + inverse[7]! * y + inverse[11]! * z + inverse[15]!;
  if (!Number.isFinite(hw) || !(Math.abs(hw) > planeIntersectionTolerance)) return undefined;
  const worldX = hx / hw;
  const worldY = hy / hw;
  const worldZ = hz / hw;
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) return undefined;
  return [worldX, worldY, worldZ];
}

function appendUnique(x: number, y: number, intersections: Vec2[]): void {
  const limit = planeIntersectionTolerance * planeIntersectionTolerance;
  for (const existing of intersections) {
    const dx = existing[0] - x;
    const dy = existing[1] - y;
    if (dx * dx + dy * dy <= limit) return;
  }
  intersections.push([x, y]);
}

function appendIfPointLiesOnPlane(point: Point3, planeZ: number, intersections: Vec2[]): void {
  if (!(Math.abs(point[2] - planeZ) <= planeIntersectionTolerance)) return;
  appendUnique(point[0], point[1], intersections);
}

function appendPlaneIntersections(start: Point3, end: Point3, planeZ: number, intersections: Vec2[]): void {
  appendIfPointLiesOnPlane(start, planeZ, intersections);
  appendIfPointLiesOnPlane(end, planeZ, intersections);
  const denominator = start[2] - end[2];
  if (!(Math.abs(denominator) > planeIntersectionTolerance)) return;
  const t = (start[2] - planeZ) / denominator;
  if (!(t >= -planeIntersectionTolerance && t <= 1 + planeIntersectionTolerance)) return;
  const clampedT = Math.min(Math.max(t, 0), 1);
  const x = start[0] + (end[0] - start[0]) * clampedT;
  const y = start[1] + (end[1] - start[1]) * clampedT;
  const z = start[2] + (end[2] - start[2]) * clampedT;
  if (!(Math.abs(z - planeZ) <= planeIntersectionTolerance)) return;
  appendUnique(x, y, intersections);
}

function sortVerticesClockwise(vertices: readonly Vec2[]): Vec2[] {
  if (vertices.length < 3) return [];
  let sumX = 0;
  let sumY = 0;
  for (const vertex of vertices) {
    sumX += vertex[0];
    sumY += vertex[1];
  }
  const centroidX = sumX / vertices.length;
  const centroidY = sumY / vertices.length;
  return [...vertices].sort((lhs, rhs) => {
    const lhsAngle = Math.atan2(lhs[1] - centroidY, lhs[0] - centroidX);
    const rhsAngle = Math.atan2(rhs[1] - centroidY, rhs[0] - centroidX);
    if (Math.abs(lhsAngle - rhsAngle) > planeIntersectionTolerance) return lhsAngle - rhsAngle;
    if (Math.abs(lhs[0] - rhs[0]) > planeIntersectionTolerance) return lhs[0] - rhs[0];
    return lhs[1] - rhs[1];
  });
}

function polygonSignedArea(vertices: readonly Vec2[]): number {
  if (vertices.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < vertices.length; index++) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area * 0.5;
}

/**
 * The frustum's footprint on the flat plane: the convex polygon the walk
 * tests every tile square against, built once per pose from the camera
 * matrix.
 *
 * On the ground relief the ground is not the plane: a tile whose square lies
 * outside the plane's footprint still rises into view where the relief lifts
 * it, at the sides and over the far edge, and ground below the plane shows
 * past that edge. The footprint is then the frustum's over the slab of the
 * world between the relief's lowest and highest heights (`make` with
 * `heights`): its cut with each of the slab's two planes and the corners of
 * the frustum within the slab, under one convex hull, which holds every cut
 * between them.
 */
export const CoveragePolygonBuilder = {
  planeIntersectionTolerance,

  /**
   * The footprint on the plane, or, with `heights`, over the slab between
   * two heights over it, in world units, the plane itself always within the
   * slab. `cameraMatrix` is the frame's projection-view matrix.
   */
  make(cameraMatrix: Mat4 | null | undefined, heights?: ClosedRange): CoveragePolygon | undefined {
    if (cameraMatrix === null || cameraMatrix === undefined) return undefined;
    if (!invertInto(inverseScratch, cameraMatrix)) return undefined;
    const frustumCorners: Point3[] = [];
    for (const corner of clipSpaceCorners) {
      const world = unprojectClipSpacePoint(corner, inverseScratch);
      if (world === undefined) return undefined;
      frustumCorners.push(world);
    }

    let planes: number[] = [0];
    if (heights !== undefined) {
      const low = Math.min(heights.lowerBound, 0);
      const high = Math.max(heights.upperBound, 0);
      planes = low < high ? [low, high] : [low];
    }
    const intersections: Vec2[] = [];
    for (const planeZ of planes) {
      for (const [start, end] of frustumEdges) {
        appendPlaneIntersections(frustumCorners[start]!, frustumCorners[end]!, planeZ, intersections);
      }
    }
    const low = planes[0]!;
    const high = planes[planes.length - 1]!;
    if (low < high) {
      for (const corner of frustumCorners) {
        if (corner[2] > low && corner[2] < high) appendUnique(corner[0], corner[1], intersections);
      }
    }

    const sortedVertices = sortVerticesClockwise(planes.length > 1 ? CoveragePolygonBuilder.convexHull(intersections) : intersections);
    if (sortedVertices.length < 3 || !(Math.abs(polygonSignedArea(sortedVertices)) > planeIntersectionTolerance)) return undefined;
    return new CoveragePolygon(sortedVertices);
  },

  /** The convex hull of the points (Andrew's monotone chain), without the points on its edges. */
  convexHull(points: readonly Vec2[]): Vec2[] {
    if (points.length <= 2) return [...points];
    const sorted = [...points].sort((lhs, rhs) => (lhs[0] !== rhs[0] ? lhs[0] - rhs[0] : lhs[1] - rhs[1]));
    const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Vec2[] = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper: Vec2[] = [];
    for (let index = sorted.length - 1; index >= 0; index--) {
      const point = sorted[index]!;
      while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  },
} as const;
