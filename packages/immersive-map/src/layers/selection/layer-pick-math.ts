// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";

/** A world position or a step in it, x east and y south, 0 to 1 across the world. */
export type World = readonly [number, number];

/**
 * A 2x2 matrix, `[m00, m10, m01, m11]` (its columns one after the other): a
 * step `(dx, dy)` maps to `(m00 dx + m01 dy, m10 dx + m11 dy)`.
 */
export type Matrix2 = readonly [number, number, number, number];

/** A place on the map under a pixel, with how the screen moves round it. */
export class LayerPickPlace {
  constructor(
    readonly world: World,
    /** Pixels per world unit at the place: a step in the world times this is the step on screen. */
    readonly pixelsPerWorld: Matrix2,
  ) {}

  /** How far `other` is from the place on screen, in pixels. */
  pixelOffset(other: World): [number, number] {
    const dx = other[0] - this.world[0];
    const dy = other[1] - this.world[1];
    const m = this.pixelsPerWorld;
    return [m[0] * dx + m[2] * dy, m[1] * dx + m[3] * dy];
  }

  /** The most a step of `pixels` on screen can be in the world. */
  worldReach(pixels: number): number {
    const inverse = invert(this.pixelsPerWorld);
    if (inverse === undefined) return Number.POSITIVE_INFINITY;
    const norm = Math.sqrt(inverse[0] ** 2 + inverse[1] ** 2 + inverse[2] ** 2 + inverse[3] ** 2);
    return pixels * norm;
  }
}

/**
 * The math of a tap on the layers of the app's data, the Swift
 * `LayerPickMath`. A tap is first turned into the place on the map under it,
 * then tested against the shapes there in the world's own space: a zone by
 * whether it holds the place, a line and a point by how far they are from it
 * on screen. The world is the Web-Mercator one of the mesh build
 * (crates/layer-mesh): x east and y south, 0 to 1 across the world.
 */
export const LayerPickMath = {
  /**
   * The place whose projection is `pixel`, found from `start` by Newton's
   * method over `project`, which gives a world position's pixel and
   * `undefined` where the map does not show it (the far side of the globe,
   * behind the camera). One method serves the globe, the flat map and the
   * morph between them, since it asks only for the projection the frame drew
   * with. `undefined` when the pixel is not on the map.
   */
  place(pixel: readonly [number, number], start: World, project: (world: World) => readonly [number, number] | undefined): LayerPickPlace | undefined {
    let world: [number, number] = [start[0], start[1]];
    // The step the slope is measured over, kept near a few pixels.
    let step = 1e-3;
    for (let iteration = 0; iteration < 32; iteration++) {
      const here = project(world);
      const east = project([world[0] + step, world[1]]);
      const south = project([world[0], world[1] + step]);
      if (here === undefined || east === undefined || south === undefined) return undefined;
      const jacobian: Matrix2 = [(east[0] - here[0]) / step, (east[1] - here[1]) / step, (south[0] - here[0]) / step, (south[1] - here[1]) / step];
      const determinant = jacobian[0] * jacobian[3] - jacobian[2] * jacobian[1];
      if (!(Math.abs(determinant) > Number.MIN_VALUE)) return undefined;
      const residual: [number, number] = [pixel[0] - here[0], pixel[1] - here[1]];
      const distance = Math.hypot(residual[0], residual[1]);
      if (distance < 0.25) return new LayerPickPlace(world, jacobian);
      const slope = Math.max(Math.hypot(jacobian[0], jacobian[1]), Math.hypot(jacobian[2], jacobian[3]));
      step = Math.min(Math.max(4 / slope, 1e-13), 1e-3);

      // The whole step, or the largest part of it that comes nearer: under a
      // tilted camera a whole step can cross the horizon.
      const inverse = invert(jacobian)!;
      const move: [number, number] = [inverse[0] * residual[0] + inverse[2] * residual[1], inverse[1] * residual[0] + inverse[3] * residual[1]];
      let fraction = 1;
      let moved = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate: [number, number] = [world[0] + move[0] * fraction, Math.min(Math.max(world[1] + move[1] * fraction, 0), 1)];
        const there = project(candidate);
        if (there !== undefined && Math.hypot(pixel[0] - there[0], pixel[1] - there[1]) < distance) {
          world = candidate;
          moved = true;
          break;
        }
        fraction /= 2;
      }
      if (!moved) return undefined;
    }
    return undefined;
  },

  coordinateOfWorld(world: World): GeoCoordinate {
    const x = world[0] - Math.floor(world[0]);
    const latitude = (Math.atan(Math.sinh(Math.PI * (1 - 2 * world[1]))) * 180) / Math.PI;
    return { latitude, longitude: x * 360 - 180 };
  },

  /** A coordinate in the Mercator world, the longitude not wrapped (the mesh build's `world`). */
  world(latitude: number, longitude: number): [number, number] {
    const maximumLatitude = (ImmersiveMapProjection.maxMercatorLatitude * 180) / Math.PI;
    const phi = (Math.min(Math.max(latitude, -maximumLatitude), maximumLatitude) * Math.PI) / 180;
    return [(longitude + 180) / 360, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2];
  },

  /**
   * A ring or a line of `count` coordinates from `first` of the interleaved
   * longitude and latitude `coordinates` in the world, each longitude run on
   * from the one before it, so it never jumps by more than half the world,
   * as the mesh build lays it. A ring's repeated last coordinate is dropped.
   */
  unwrappedWorld(coordinates: Float64Array, first: number, count: number): [number, number][] {
    const points: [number, number][] = [];
    let previous: [number, number] | undefined;
    for (let i = 0; i < count; i++) {
      const longitude = coordinates[(first + i) * 2]!;
      const latitude = coordinates[(first + i) * 2 + 1]!;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const point = LayerPickMath.world(latitude, longitude);
      if (previous !== undefined) point[0] += Math.round(previous[0] - point[0]);
      const last = points[points.length - 1];
      if (last !== undefined && (last[0] - point[0]) ** 2 + (last[1] - point[1]) ** 2 < 1e-24) continue;
      points.push(point);
      previous = point;
    }
    if (points.length > 1) {
      const a = points[0]!;
      const b = points[points.length - 1]!;
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 1e-24) points.pop();
    }
    return points;
  },

  /** Whether a ring holds `point`, by the even-odd rule. */
  ringContains(ring: readonly World[], point: World): boolean {
    let inside = false;
    let previous = ring.length - 1;
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index]!;
      const b = ring[previous]!;
      if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      previous = index;
    }
    return inside;
  },

  /** How far the origin is from the segment `a`-`b`. */
  distanceFromOriginToSegment(a: World, b: World): number {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const lengthSquared = abx * abx + aby * aby;
    if (!(lengthSquared > 0)) return Math.hypot(a[0], a[1]);
    const t = Math.min(Math.max(-(a[0] * abx + a[1] * aby) / lengthSquared, 0), 1);
    return Math.hypot(a[0] + abx * t, a[1] + aby * t);
  },

  /**
   * Whether a box of degrees round `count` coordinates from `first`,
   * widened by `margin`, holds `coordinate`, in whichever copy of the world
   * its longitudes were written.
   */
  boxHolds(coordinates: Float64Array, first: number, count: number, coordinate: GeoCoordinate, margin: number): boolean {
    if (count <= 0) return false;
    let minLat = Number.POSITIVE_INFINITY;
    let minLon = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const longitude = coordinates[(first + i) * 2]!;
      const latitude = coordinates[(first + i) * 2 + 1]!;
      minLat = Math.min(minLat, latitude);
      maxLat = Math.max(maxLat, latitude);
      minLon = Math.min(minLon, longitude);
      maxLon = Math.max(maxLon, longitude);
    }
    if (coordinate.latitude < minLat - margin || coordinate.latitude > maxLat + margin) return false;
    // A shape across the 180th meridian written with a jump spans the world in longitude: it is not ruled out here.
    if (maxLon - minLon > 180) return true;
    for (const turn of [-360, 0, 360]) {
      const longitude = coordinate.longitude + turn;
      if (longitude >= minLon - margin && longitude <= maxLon + margin) return true;
    }
    return false;
  },
} as const;

function invert(m: Matrix2): Matrix2 | undefined {
  const determinant = m[0] * m[3] - m[2] * m[1];
  if (determinant === 0 || !Number.isFinite(determinant)) return undefined;
  return [m[3] / determinant, -m[1] / determinant, -m[2] / determinant, m[0] / determinant];
}
