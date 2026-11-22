// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TerrainSurroundingsSettings } from "../../../configuration/tile-settings.ts";
import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../../math/vec.ts";
import type { GroundReliefFrame } from "../frame/ground-relief-frame.ts";
import type { ImmersiveMapTerrainSurroundings } from "./terrain-surroundings.ts";

/**
 * Reads what the country around the point the camera looks at is like off
 * the frame's relief (`ImmersiveMapTerrainSurroundings`), once a frame while
 * the frame is on the terrain, a port of the Swift
 * `GroundReliefSurroundings`. The frame's own reading, kept across frames
 * for the smoothing and the hysteresis.
 *
 * The heights are read on the CPU from the camera's own terrain map, at the
 * centre and on two rings around it, a few dozen lookups. The sample is
 * taken again only when the point has moved a share of the radius, the
 * terrain in has changed or the radius was set, and the smoothing runs
 * every frame from the last sample.
 */
export class GroundReliefSurroundings {
  /** Points on the outer ring, at the radius, and on the inner ring, at half of it. */
  static readonly outerRingCount = 16;
  static readonly innerRingCount = 8;
  /** How far the point moves, as a share of the radius, before the disc is sampled again. */
  static readonly resampleShare = 0.02;

  private smoothedSpanMetres: number | undefined;
  private kindValue: ImmersiveMapTerrainSurroundings["kind"] | undefined;
  private sampledSpanMetres: number | undefined;
  private sampledCentre: Vec2 | undefined;
  private sampledVersion: number | undefined;
  private sampledRadiusMetres: number | undefined;

  /**
   * The reading for this frame, `null` off the terrain, and `null` while
   * the terrain under the point is still on its way the first time. Off the
   * terrain the smoothing and the kind are dropped.
   */
  update(relief: GroundReliefFrame, centerWorldMercator: Vec2, settings: TerrainSurroundingsSettings, deltaTime: number): ImmersiveMapTerrainSurroundings | null {
    if (!relief.isActive) {
      this.reset();
      return null;
    }
    this.sample(relief, centerWorldMercator, settings);
    const sampled = this.sampledSpanMetres;
    if (sampled === undefined) return null;
    let smoothed: number;
    if (this.smoothedSpanMetres !== undefined) {
      const share = GroundReliefSurroundings.smoothingShare(deltaTime, settings.smoothingHalfLife);
      smoothed = this.smoothedSpanMetres + (sampled - this.smoothedSpanMetres) * share;
    } else {
      smoothed = sampled;
    }
    this.smoothedSpanMetres = smoothed;
    const kind = GroundReliefSurroundings.kind(this.kindValue, smoothed, settings);
    this.kindValue = kind;
    // Rounded so a reading that moves by less than the app can see compares
    // equal to the last one and is not reported again.
    return {
      kind,
      mountainousness: Math.round(GroundReliefSurroundings.mountainousness(smoothed, settings) * 100) / 100,
      heightSpanMetres: Math.round(smoothed),
      groundMetres: Math.round(relief.datumMetres),
    };
  }

  reset(): void {
    this.smoothedSpanMetres = undefined;
    this.kindValue = undefined;
    this.sampledSpanMetres = undefined;
    this.sampledCentre = undefined;
    this.sampledVersion = undefined;
    this.sampledRadiusMetres = undefined;
  }

  private sample(relief: GroundReliefFrame, centerWorldMercator: Vec2, settings: TerrainSurroundingsSettings): void {
    const radiusMetres = Math.max(settings.sampleRadiusMetres, 1);
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(centerWorldMercator[1]);
    const metresPerWorld = ImmersiveMapProjection.earthCircumferenceMeters * Math.max(Math.cos(latitude), 1e-6);
    const radiusWorld = radiusMetres / metresPerWorld;
    const centre = this.sampledCentre;
    if (
      centre !== undefined &&
      this.sampledVersion === relief.version &&
      this.sampledRadiusMetres === radiusMetres &&
      Math.hypot(centerWorldMercator[0] - centre[0], centerWorldMercator[1] - centre[1]) < radiusWorld * GroundReliefSurroundings.resampleShare
    ) {
      return;
    }
    const span = GroundReliefSurroundings.spanMetres(centerWorldMercator, radiusWorld, (point) => relief.elevation(point, relief.cameraTerrainZoom));
    if (span === undefined) return;
    this.sampledSpanMetres = span;
    this.sampledCentre = centerWorldMercator;
    this.sampledVersion = relief.version;
    this.sampledRadiusMetres = radiusMetres;
  }

  /** The highest less the lowest of the heights `read` answers at the centre and on the two rings, `undefined` when fewer than two points have terrain under them. */
  static spanMetres(centerWorldMercator: Vec2, radiusWorld: number, read: (point: Vec2) => number | undefined): number | undefined {
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let count = 0;
    const take = (point: Vec2) => {
      const metres = read(point);
      if (metres === undefined) return;
      lowest = Math.min(lowest, metres);
      highest = Math.max(highest, metres);
      count += 1;
    };
    take(centerWorldMercator);
    for (const [ringCount, radius] of [
      [GroundReliefSurroundings.outerRingCount, radiusWorld],
      [GroundReliefSurroundings.innerRingCount, radiusWorld * 0.5],
    ] as const) {
      for (let index = 0; index < ringCount; index++) {
        const angle = (index / ringCount) * 2 * Math.PI;
        take([centerWorldMercator[0] + Math.cos(angle) * radius, centerWorldMercator[1] + Math.sin(angle) * radius]);
      }
    }
    if (count < 2) return undefined;
    return highest - lowest;
  }

  /** The share of the way from the smoothed span to the sampled one a frame of `deltaTime` goes: half the way every `halfLife` seconds. */
  static smoothingShare(deltaTime: number, halfLife: number): number {
    if (!(halfLife > 0) || !(deltaTime > 0)) return 1;
    return 1 - 0.5 ** (deltaTime / halfLife);
  }

  /** Where the span lies between the two thresholds, 0 to 1. With the thresholds crossed, a step at the mountains' threshold. */
  static mountainousness(spanMetres: number, settings: TerrainSurroundingsSettings): number {
    const width = settings.mountainsAboveMetres - settings.plainBelowMetres;
    if (!(width > 0)) return spanMetres >= settings.mountainsAboveMetres ? 1 : 0;
    return Math.min(Math.max((spanMetres - settings.plainBelowMetres) / width, 0), 1);
  }

  /** The kind after this frame's span: mountains from the mountains' threshold up, a plain from the plain's down, and between them what it was. */
  static kind(previous: ImmersiveMapTerrainSurroundings["kind"] | undefined, spanMetres: number, settings: TerrainSurroundingsSettings): ImmersiveMapTerrainSurroundings["kind"] {
    if (spanMetres >= settings.mountainsAboveMetres) return "mountains";
    if (spanMetres <= settings.plainBelowMetres) return "plain";
    if (previous !== undefined) return previous;
    return GroundReliefSurroundings.mountainousness(spanMetres, settings) >= 0.5 ? "mountains" : "plain";
  }
}
