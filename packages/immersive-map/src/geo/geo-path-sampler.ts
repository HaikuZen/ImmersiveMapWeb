// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "./geo-coordinate.ts";
import { GeoGreatCircleMath } from "./geo-great-circle-math.ts";
import { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { ImmersiveMapGeoPath } from "./immersive-map-geo-path.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

/**
 * One point of a path resolved for rendering or for placing a model: where it
 * is, how high, how far along, and which way the trajectory points there.
 */
export interface GeoPathSample {
  readonly coordinate: GeoCoordinate;
  /** Cached projection trigonometry, so the per-frame world build stays linear algebra. */
  readonly basis: GeoProjectionBasis;
  readonly altitudeMeters: number;
  /** Position along the path by arc length, `0...1`. */
  readonly fraction: number;
  /** Course of the trajectory, clockwise from north, in degrees. */
  readonly headingDegrees: number;
  /** Climb angle of the altitude profile, in degrees. Positive is nose up. */
  readonly pitchDegrees: number;
}

const degenerateSegmentAngleRadians = 1e-9;
const groundRadiusMeters = ImmersiveMapProjection.earthCircumferenceMeters / (2.0 * Math.PI);

/**
 * Arc-length geometry derived from a path once: cleaned waypoints,
 * per-segment central angles and their running sums. Building it is the only
 * place that walks the waypoint list, so both the ribbon tessellation and the
 * per-frame model position resolve a fraction the same way.
 */
export class GeoPathMetrics {
  /**
   * About 27.8 km of ground per step. The globe presentation ends near zoom
   * 7, where one pixel is roughly 611 meters, and the chord sagitta of a
   * 0.25 degree step is about 15 meters, that is 0.025 pixels. Two orders of
   * margin, and a pole-to-pole path still fits in 721 samples.
   */
  static readonly angularStepRadians = (0.25 * Math.PI) / 180.0;
  static readonly maximumSampleCount = 2048;
  /**
   * The arm of the central difference for the heading and the pitch, as a
   * share of the path's length, between `minimumDerivativeArmMeters` and
   * half a sample step.
   *
   * Half a sample step alone (13.9 km) is too long for a short path: on a
   * path shorter than one step the whole path is one step, and the arm
   * reached halfway across it, so the heading of a street-level path was the
   * chord toward its middle (on a loop, across the loop), not the course
   * along the street. A fixed short arm instead would turn a model on a long
   * flight round its corners at once, where it banks round them over the
   * arm. A share of the length does both: a model or the camera turns round
   * a corner over the same share of the path whatever its length, a street-
   * level path reads its own legs, and a path of 2,780 km or more keeps the
   * half step it always had.
   */
  static readonly derivativeArmShare = 0.01;
  /** The shortest arm, in meters of ground: below it, a path of a few hundred meters would read the noise of its waypoints. */
  static readonly minimumDerivativeArmMeters = 50;

  readonly path: ImmersiveMapGeoPath;
  /** Waypoints with zero-length segments removed. At least two entries. */
  readonly waypoints: readonly GeoCoordinate[];
  /** Central angle of every segment, `waypoints.length - 1` entries. */
  readonly segmentAngles: readonly number[];
  /** Running sums of `segmentAngles`, `waypoints.length` entries starting at 0. */
  readonly cumulativeAngles: readonly number[];
  readonly totalAngleRadians: number;

  private constructor(path: ImmersiveMapGeoPath, waypoints: GeoCoordinate[], segmentAngles: number[], cumulativeAngles: number[], total: number) {
    this.path = path;
    this.waypoints = waypoints;
    this.segmentAngles = segmentAngles;
    this.cumulativeAngles = cumulativeAngles;
    this.totalAngleRadians = total;
  }

  /**
   * Null when the path cannot describe a trajectory: fewer than two distinct
   * waypoints, or every point coincident.
   */
  static make(path: ImmersiveMapGeoPath): GeoPathMetrics | null {
    const waypoints: GeoCoordinate[] = [];
    const segmentAngles: number[] = [];
    const cumulativeAngles: number[] = [];
    let runningAngle = 0;

    for (const waypoint of path.waypoints) {
      const previous = waypoints[waypoints.length - 1];
      if (previous === undefined) {
        waypoints.push(waypoint);
        cumulativeAngles.push(0);
        continue;
      }
      const angle = GeoGreatCircleMath.centralAngle(previous, waypoint);
      if (!(angle > degenerateSegmentAngleRadians)) {
        continue;
      }
      runningAngle += angle;
      waypoints.push(waypoint);
      segmentAngles.push(angle);
      cumulativeAngles.push(runningAngle);
    }

    if (waypoints.length < 2 || !(runningAngle > 0)) {
      return null;
    }
    return new GeoPathMetrics(path, waypoints, segmentAngles, cumulativeAngles, runningAngle);
  }

  /** Number of samples the ribbon is tessellated into. */
  get sampleCount(): number {
    const stepped = Math.ceil(this.totalAngleRadians / GeoPathMetrics.angularStepRadians) + 1;
    return Math.min(Math.max(stepped, 2), GeoPathMetrics.maximumSampleCount);
  }

  /**
   * The arm of the central difference used for heading and pitch: a share
   * of the path (`derivativeArmShare`), at least `minimumDerivativeArmMeters`
   * of ground, at most half a sample step. Shared by the ribbon, the animated
   * model and the camera's follow, so they agree.
   */
  get derivativeFraction(): number {
    const halfStep = 0.5 / (this.sampleCount - 1);
    const pathMeters = this.totalAngleRadians * groundRadiusMeters;
    if (!(pathMeters > 0)) return halfStep;
    const arm = Math.max(GeoPathMetrics.derivativeArmShare, GeoPathMetrics.minimumDerivativeArmMeters / pathMeters);
    return Math.min(halfStep, arm);
  }

  coordinate(fraction: number): GeoCoordinate {
    const clamped = Math.min(Math.max(fraction, 0), 1);
    const targetAngle = clamped * this.totalAngleRadians;
    const segment = this.segmentIndex(targetAngle);
    return this.coordinateInSegment(segment, targetAngle);
  }

  sample(fraction: number): GeoPathSample {
    const clamped = Math.min(Math.max(fraction, 0), 1);
    const targetAngle = clamped * this.totalAngleRadians;
    return this.sampleAt(clamped, targetAngle, this.segmentIndex(targetAngle));
  }

  /** Every sample of the tessellated path, ordered from fraction 0 to 1. */
  samples(): GeoPathSample[] {
    const count = this.sampleCount;
    const result: GeoPathSample[] = [];
    let segment = 0;
    for (let index = 0; index < count; index++) {
      const fraction = index / (count - 1);
      const targetAngle = fraction * this.totalAngleRadians;
      segment = this.segmentIndex(targetAngle, segment);
      result.push(this.sampleAt(fraction, targetAngle, segment));
    }
    return result;
  }

  private sampleAt(fraction: number, targetAngle: number, segment: number): GeoPathSample {
    const coordinate = this.coordinateInSegment(segment, targetAngle);
    const delta = this.derivativeFraction;
    const before = Math.max(0, fraction - delta);
    const after = Math.min(1, fraction + delta);
    const heading = GeoGreatCircleMath.bearingDegrees(this.coordinate(before), this.coordinate(after));

    const groundDistance = (after - before) * this.totalAngleRadians * groundRadiusMeters;
    const altitudeDelta = ImmersiveMapGeoPath.altitudeMeters(this.path, after) - ImmersiveMapGeoPath.altitudeMeters(this.path, before);
    const pitch = groundDistance > 0 ? (Math.atan2(altitudeDelta, groundDistance) * 180.0) / Math.PI : 0;

    return {
      coordinate,
      basis: GeoProjectionBasis.fromCoordinate(coordinate),
      altitudeMeters: ImmersiveMapGeoPath.altitudeMeters(this.path, fraction),
      fraction,
      headingDegrees: heading,
      pitchDegrees: pitch,
    };
  }

  private coordinateInSegment(segment: number, targetAngle: number): GeoCoordinate {
    const segmentAngle = this.segmentAngles[segment]!;
    const localProgress = segmentAngle > 0 ? (targetAngle - this.cumulativeAngles[segment]!) / segmentAngle : 0;
    return GeoGreatCircleMath.coordinate(this.waypoints[segment]!, this.waypoints[segment + 1]!, localProgress);
  }

  /**
   * Index of the segment containing `targetAngle`. `start` lets a sequential
   * walk stay linear instead of rescanning from the beginning.
   */
  private segmentIndex(targetAngle: number, start = 0): number {
    let index = Math.min(Math.max(start, 0), this.segmentAngles.length - 1);
    while (index + 1 < this.segmentAngles.length && targetAngle > this.cumulativeAngles[index + 1]!) {
      index += 1;
    }
    return index;
  }
}

/**
 * Builds metrics on demand for a one-shot tessellation. Callers that resolve
 * a path every frame keep the `GeoPathMetrics` instead.
 */
export const GeoPathSampler = {
  samples(path: ImmersiveMapGeoPath): GeoPathSample[] {
    return GeoPathMetrics.make(path)?.samples() ?? [];
  },
} as const;
