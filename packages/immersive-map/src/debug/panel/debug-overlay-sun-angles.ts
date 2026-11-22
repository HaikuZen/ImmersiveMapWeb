// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vector3 } from "../../configuration/color.ts";
import type { DebugOverlayPoint, DebugOverlayRect } from "./debug-overlay-geometry.ts";
import { clampTo, rectMaxY, rectMidX, rectMidY } from "./debug-overlay-geometry.ts";

/** A sun's place in the sky, in degrees: the compass bearing (0 north, 90 east) and the height over the horizon. */
export interface DebugOverlaySunAngles {
  readonly azimuthDegrees: number;
  readonly elevationDegrees: number;
}

/**
 * The azimuth and elevation of the static sun, and the world direction
 * they stand for (the Swift `DebugOverlaySunAngles`).
 *
 * `SceneLightSettings.direction` points toward the sun in the flat basis
 * (+x east, +y north, +z up), so the two angles map onto it directly. A low
 * elevation throws long shadows. The panel edits the angles rather than the
 * vector because dragging a slider through a raw XYZ direction is not a
 * thing anyone can aim.
 */
export const DebugOverlaySunAngles = {
  direction(azimuthDegrees: number, elevationDegrees: number): Vector3 {
    const azimuth = (azimuthDegrees * Math.PI) / 180;
    const elevation = (elevationDegrees * Math.PI) / 180;
    return [Math.cos(elevation) * Math.sin(azimuth), Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation)];
  },

  /** The inverse. A degenerate direction reads as the overhead sun rather than as a NaN that would travel into a slider. */
  angles(direction: Vector3): DebugOverlaySunAngles {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(length > 1e-6) || !Number.isFinite(length)) {
      return { azimuthDegrees: 0, elevationDegrees: 90 };
    }
    const x = direction[0] / length;
    const y = direction[1] / length;
    const z = direction[2] / length;
    const azimuth = (Math.atan2(x, y) * 180) / Math.PI;
    return {
      azimuthDegrees: azimuth < 0 ? azimuth + 360 : azimuth,
      elevationDegrees: (Math.asin(clampTo(z, -1, 1)) * 180) / Math.PI,
    };
  },
} as const;

function normalizedDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  // Plus zero: a negative zero would read "-0°".
  return wrapped < 0 ? wrapped + 360 : wrapped + 0;
}

/** The side view's ground point and its quarter circle's radius, in the view's pixels, y down. */
export interface DebugOverlaySunSideGeometry {
  readonly origin: DebugOverlayPoint;
  readonly radius: number;
}

/**
 * The geometry of the panel's sun picker (the Swift `DebugOverlaySunDial`
 * and the arithmetic of its two views): the sky seen from above as a disc
 * and from the side as a quarter circle.
 *
 * The disc turns with the camera: up is the direction the camera looks in,
 * so a sun dragged to the top shines from in front of the view and one
 * dragged to the bottom from behind it. The sun itself stays where the world
 * puts it (`SceneLightSettings.direction`), the disc only reads and sets it
 * from the view. The direction from the centre is the sun's azimuth, the
 * distance its elevation, the zenith at the centre and the horizon on the
 * rim, at an even step of degrees. The side view is the elevation alone,
 * the horizon to the right and the zenith straight up. The disc's rings
 * stand at `ringElevations`, the compass letters at `compass`.
 */
export const DebugOverlaySunDial = {
  /** Room around the disc for the view's arrow, and under the side view's ground. */
  margin: 12,
  /** The dashed rings of the disc and the ticks of the side view, in degrees of elevation. */
  ringElevations: Object.freeze([30, 60]) as readonly number[],
  /** The compass letters round the disc's rim, turned with the view, north drawn in red. */
  compass: Object.freeze([
    { letter: "N", azimuthDegrees: 0 },
    { letter: "E", azimuthDegrees: 90 },
    { letter: "S", azimuthDegrees: 180 },
    { letter: "W", azimuthDegrees: 270 },
  ]) as readonly { readonly letter: string; readonly azimuthDegrees: number }[],

  /**
   * The compass direction the camera looks in, in degrees clockwise from
   * north, 0 to 360: the camera turned by `bearingRadians` sees the world
   * rotated by it, so its view is the bearing's opposite turn.
   */
  viewAzimuthDegrees(bearingRadians: number): number {
    return normalizedDegrees((-bearingRadians * 180) / Math.PI);
  },

  /** Where a sun stands in the disc, in its unit radius with y up, seen from a camera looking at `viewAzimuthDegrees`. */
  point(azimuthDegrees: number, elevationDegrees: number, viewAzimuthDegrees: number): DebugOverlayPoint {
    const relative = ((azimuthDegrees - viewAzimuthDegrees) * Math.PI) / 180;
    const radius = (90 - clampTo(elevationDegrees, 0, 90)) / 90;
    return { x: radius * Math.sin(relative), y: radius * Math.cos(relative) };
  },

  /**
   * The sun at a point of the disc (unit radius, y up), the inverse of
   * `point`: the rim and past it is the horizon, and the elevation keeps to
   * `elevationRange`. At the very centre the direction is undefined and
   * `azimuthDegrees` is kept.
   */
  angles(
    point: DebugOverlayPoint,
    viewAzimuthDegrees: number,
    azimuthDegrees: number,
    elevationRange: { readonly lowerBound: number; readonly upperBound: number },
  ): DebugOverlaySunAngles {
    const radius = Math.min(Math.hypot(point.x, point.y), 1);
    const azimuth = radius > 1e-6 ? normalizedDegrees(viewAzimuthDegrees + (Math.atan2(point.x, point.y) * 180) / Math.PI) : azimuthDegrees;
    const elevation = clampTo(90 - radius * 90, elevationRange.lowerBound, elevationRange.upperBound);
    return { azimuthDegrees: azimuth, elevationDegrees: elevation };
  },

  /**
   * The elevation at a point of the side view, from the ground's point at
   * the origin, y up: the angle of the point over the horizon, either side
   * of the origin, kept to `elevationRange`.
   */
  elevation(sidePoint: DebugOverlayPoint, elevationRange: { readonly lowerBound: number; readonly upperBound: number }): number {
    const degrees = (Math.atan2(Math.max(sidePoint.y, 0), Math.abs(sidePoint.x)) * 180) / Math.PI;
    return clampTo(degrees, elevationRange.lowerBound, elevationRange.upperBound);
  },

  /** The disc in a view of `bounds`: the largest square that leaves `margin` all round, centred. */
  discRect(bounds: DebugOverlayRect): DebugOverlayRect {
    const side = Math.min(bounds.width, bounds.height) - DebugOverlaySunDial.margin * 2;
    return { x: rectMidX(bounds) - side / 2, y: rectMidY(bounds) - side / 2, width: side, height: side };
  },

  /** A pointer in the view's pixels (y down) as a point of the disc in its unit radius (y up), `undefined` for a disc of no size. */
  discPoint(pointer: DebugOverlayPoint, disc: DebugOverlayRect): DebugOverlayPoint | undefined {
    if (!(disc.width > 0)) return undefined;
    return { x: (pointer.x - rectMidX(disc)) / (disc.width / 2), y: -(pointer.y - rectMidY(disc)) / (disc.height / 2) };
  },

  /** A point of the disc in its unit radius (y up) in the view's pixels (y down): where to draw a sun or a compass letter. */
  discPixel(point: DebugOverlayPoint, disc: DebugOverlayRect, inset = 0): DebugOverlayPoint {
    const radius = disc.width / 2 - inset;
    return { x: rectMidX(disc) + point.x * radius, y: rectMidY(disc) - point.y * radius };
  },

  /** The side view in a view of `bounds`: the ground's point at the bottom, the quarter circle's radius as large as the margins allow. */
  sideGeometry(bounds: DebugOverlayRect): DebugOverlaySunSideGeometry {
    const margin = DebugOverlaySunDial.margin;
    const radius = Math.max(0, Math.min(bounds.width - margin * 2, bounds.height - margin * 2));
    return { origin: { x: rectMidX(bounds) - radius / 2, y: rectMaxY(bounds) - margin }, radius };
  },

  /** A pointer in the view's pixels (y down) as a point from the side view's ground point, y up, for `elevation`. */
  sidePoint(pointer: DebugOverlayPoint, geometry: DebugOverlaySunSideGeometry): DebugOverlayPoint {
    return { x: pointer.x - geometry.origin.x, y: geometry.origin.y - pointer.y };
  },

  /** Where the sun of an elevation stands on the side view's quarter circle, in the view's pixels (y down). */
  sidePixel(elevationDegrees: number, geometry: DebugOverlaySunSideGeometry, inset = 0): DebugOverlayPoint {
    const angle = (elevationDegrees * Math.PI) / 180;
    const radius = geometry.radius - inset;
    return { x: geometry.origin.x + Math.cos(angle) * radius, y: geometry.origin.y - Math.sin(angle) * radius };
  },
} as const;
