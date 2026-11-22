// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraBounds, PullCurve } from "../configuration/camera-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { ClosedRange } from "../math/closed-range.ts";
import type { Vec2 } from "../math/vec.ts";

/**
 * The area the center belongs in at a zoom. `halfWidth` is measured from the
 * region's middle and is null when every longitude is in it.
 */
interface Area {
  readonly halfWidth: number | null;
  readonly lowestY: number;
  readonly highestY: number;
}

/** One frame of the elastic pull: the new center and the distance still left, in world units. */
export interface BoundsReturnStep {
  readonly center: Vec2;
  readonly remainingDistance: number;
}

/**
 * The geometry of `CameraSettings.bounds`. The area the center belongs in is
 * the region in normalized world Mercator, widened on every side by a share
 * of the distance from that side to the edge of the world: all of it below
 * the pull's zoom range, none of it above, and the curve's value in between.
 * A hard edge clamps to the area (`apply`), an elastic one damps a move past
 * it (`resist`) and pulls the center back (`returnStep`). Longitude is
 * measured around the region's middle, so a region across the antimeridian
 * behaves like any other.
 */
export class CameraBoundsConstraint {
  private readonly centerX: number;
  private readonly halfWidth: number;
  private readonly minimumY: number;
  private readonly maximumY: number;
  private readonly pullZoomRange: ClosedRange;
  private readonly pullCurve: PullCurve;

  constructor(bounds: CameraBounds) {
    const westX = (bounds.southWest.longitude + 180) / 360;
    const eastX = (bounds.northEast.longitude + 180) / 360;
    let width = eastX - westX;
    if (width < 0) {
      width += 1;
    }
    width = Math.min(width, 1);
    this.centerX = westX + width * 0.5;
    this.halfWidth = width * 0.5;

    const degreesToRadians = Math.PI / 180;
    const southY = ImmersiveMapProjection.worldMercator(bounds.southWest.latitude * degreesToRadians, 0)[1];
    const northY = ImmersiveMapProjection.worldMercator(bounds.northEast.latitude * degreesToRadians, 0)[1];
    this.minimumY = Math.min(southY, northY);
    this.maximumY = Math.max(southY, northY);
    this.pullZoomRange = bounds.pullZoomRange;
    this.pullCurve = bounds.pullCurve;
  }

  private area(zoom: number): Area {
    const openShare = 1 - this.pull(zoom);
    const allowedHalfWidth = this.halfWidth + (0.5 - this.halfWidth) * openShare;
    return {
      halfWidth: allowedHalfWidth < 0.5 ? allowedHalfWidth : null,
      lowestY: this.minimumY * (1 - openShare),
      highestY: this.maximumY + (1 - this.maximumY) * openShare,
    };
  }

  /** The nearest point of the area at `zoom`. */
  apply(centerWorldMercator: Vec2, zoom: number): Vec2 {
    const area = this.area(zoom);
    let x = centerWorldMercator[0];
    if (area.halfWidth !== null) {
      const offset = shortOffset(x - this.centerX);
      x = this.centerX + Math.min(Math.max(offset, -area.halfWidth), area.halfWidth);
    }
    const y = Math.min(Math.max(centerWorldMercator[1], area.lowestY), area.highestY);
    return [ImmersiveMapProjection.wrapNormalizedWorldX(x), ImmersiveMapProjection.clampNormalizedWorldY(y)];
  }

  /**
   * Moves the center from `current` toward `proposed` against the elastic
   * edge: inside the area and back toward it the move is free, past the edge
   * it is damped so the distance past it approaches `maximumStretch`, in
   * world units, and never reaches it. A center already that far out (a zoom
   * can put it there) moves no further out.
   */
  resist(current: Vec2, proposed: Vec2, zoom: number, maximumStretch: number): Vec2 {
    const area = this.area(zoom);
    let x = proposed[0];
    if (area.halfWidth !== null) {
      const currentOffset = shortOffset(current[0] - this.centerX);
      const proposedOffset = currentOffset + shortOffset(proposed[0] - current[0]);
      x = this.centerX + stretch(currentOffset, proposedOffset, -area.halfWidth, area.halfWidth, maximumStretch);
    }
    const y = stretch(current[1], proposed[1], area.lowestY, area.highestY, maximumStretch);
    return [ImmersiveMapProjection.wrapNormalizedWorldX(x), ImmersiveMapProjection.clampNormalizedWorldY(y)];
  }

  /** How far the center is from the area, in world units, the short way around in longitude. */
  distanceOutside(center: Vec2, zoom: number): number {
    const target = this.apply(center, zoom);
    return Math.hypot(shortOffset(target[0] - center[0]), target[1] - center[1]);
  }

  /**
   * One frame of the elastic pull: the center moves `fraction` of the way to
   * the nearest point of the area, the short way around in longitude.
   */
  returnStep(center: Vec2, zoom: number, fraction: number): BoundsReturnStep {
    const target = this.apply(center, zoom);
    const gapX = shortOffset(target[0] - center[0]);
    const gapY = target[1] - center[1];
    const share = Math.min(Math.max(fraction, 0), 1);
    const next: Vec2 = [
      ImmersiveMapProjection.wrapNormalizedWorldX(center[0] + gapX * share),
      ImmersiveMapProjection.clampNormalizedWorldY(center[1] + gapY * share),
    ];
    const remaining = Math.hypot(shortOffset(target[0] - next[0]), target[1] - next[1]);
    return { center: next, remainingDistance: remaining };
  }

  /**
   * How far the reachable area has closed in on the region at a zoom: 0 for
   * the whole world, 1 for the region alone.
   */
  pull(zoom: number): number {
    const lower = this.pullZoomRange.lowerBound;
    const span = this.pullZoomRange.upperBound - lower;
    if (!(span > Number.MIN_VALUE)) {
      return zoom >= lower ? 1 : 0;
    }
    const progress = Math.min(Math.max((zoom - lower) / span, 0), 1);
    return Math.min(Math.max(pullCurveValue(this.pullCurve, progress), 0), 1);
  }
}

/**
 * The rubber band on one axis. Past an edge the visible distance `d` and the
 * distance the drag has travelled `u` are related by `d = L u / (L + u)`:
 * slope 1 at the edge, tending to `L`. The drag's travel is recovered from
 * the current distance, so no state is kept between moves.
 */
function stretch(current: number, proposed: number, lowerEdge: number, upperEdge: number, maximumStretch: number): number {
  if (!(maximumStretch > 0)) {
    return Math.min(Math.max(proposed, lowerEdge), upperEdge);
  }

  if (proposed > upperEdge && proposed > current) {
    const past = Math.max(current - upperEdge, 0);
    if (!(past < maximumStretch)) {
      return current;
    }
    const travel = (maximumStretch * past) / (maximumStretch - past) + (proposed - Math.max(current, upperEdge));
    return upperEdge + (maximumStretch * travel) / (maximumStretch + travel);
  }
  if (proposed < lowerEdge && proposed < current) {
    const past = Math.max(lowerEdge - current, 0);
    if (!(past < maximumStretch)) {
      return current;
    }
    const travel = (maximumStretch * past) / (maximumStretch - past) + (Math.min(current, lowerEdge) - proposed);
    return lowerEdge - (maximumStretch * travel) / (maximumStretch + travel);
  }
  return proposed;
}

/** A longitude difference taken the short way around the world, in -0.5..<0.5. */
function shortOffset(offset: number): number {
  let wrapped = offset % 1;
  if (wrapped >= 0.5) {
    wrapped -= 1;
  } else if (wrapped < -0.5) {
    wrapped += 1;
  }
  return wrapped;
}

/**
 * The curve's y at `x` in 0...1: the Bezier parameter whose x matches is
 * found by Newton's method, with bisection where the slope is too flat for
 * it.
 */
export function pullCurveValue(curve: PullCurve, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }

  let t = x;
  for (let iteration = 0; iteration < 8; iteration++) {
    const error = bezierCoordinate(t, curve.x1, curve.x2) - x;
    if (Math.abs(error) < 1e-9) {
      return bezierCoordinate(t, curve.y1, curve.y2);
    }
    const slope = bezierDerivative(t, curve.x1, curve.x2);
    if (!(Math.abs(slope) > 1e-6)) {
      break;
    }
    t = Math.min(Math.max(t - error / slope, 0), 1);
  }

  let low = 0.0;
  let high = 1.0;
  t = x;
  for (let iteration = 0; iteration < 60; iteration++) {
    const value = bezierCoordinate(t, curve.x1, curve.x2);
    if (Math.abs(value - x) < 1e-9) {
      break;
    }
    if (value < x) {
      low = t;
    } else {
      high = t;
    }
    t = (low + high) * 0.5;
  }
  return bezierCoordinate(t, curve.y1, curve.y2);
}

/** One coordinate of the Bezier from 0 to 1 with control values `p1`, `p2`. */
function bezierCoordinate(t: number, p1: number, p2: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
}

function bezierDerivative(t: number, p1: number, p2: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * p1 + 6 * inverse * t * (p2 - p1) + 3 * t * t * (1 - p2);
}
