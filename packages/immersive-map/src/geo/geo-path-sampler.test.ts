// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { geoCoordinate } from "./geo-coordinate.ts";
import { GeoGreatCircleMath } from "./geo-great-circle-math.ts";
import { GeoPathMetrics, GeoPathSampler } from "./geo-path-sampler.ts";
import { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { ImmersiveMapGeoPath } from "./immersive-map-geo-path.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function metricsOf(path: ImmersiveMapGeoPath): GeoPathMetrics {
  const metrics = GeoPathMetrics.make(path);
  expect(metrics).not.toBeNull();
  return metrics!;
}

/**
 * The sampler is the single source of "where is fraction f on this path",
 * shared by the drawn ribbon and by the model flying along it, so its
 * parameterization, altitude profile and derivatives are pinned here.
 */
describe("GeoPathSampler", () => {
  // Degenerate paths

  test("fewer than two waypoints produce no metrics", () => {
    expect(GeoPathMetrics.make(ImmersiveMapGeoPath.make([]))).toBeNull();
    expect(GeoPathMetrics.make(ImmersiveMapGeoPath.make([geoCoordinate(1, 2)]))).toBeNull();
    expect(GeoPathSampler.samples(ImmersiveMapGeoPath.make([]))).toEqual([]);
  });

  test("coincident waypoints produce no metrics", () => {
    const point = geoCoordinate(10, 20);
    expect(GeoPathMetrics.make(ImmersiveMapGeoPath.make([point, point, point]))).toBeNull();
  });

  test("duplicate waypoints are dropped without breaking the parameterization", () => {
    const start = geoCoordinate(0, 0);
    const end = geoCoordinate(0, 40);
    const metrics = metricsOf(ImmersiveMapGeoPath.make([start, start, end, end]));
    expect(metrics.waypoints.length).toBe(2);
    expectClose(metrics.sample(0).coordinate.longitude, 0, 1e-9);
    expectClose(metrics.sample(1).coordinate.longitude, 40, 1e-9);
  });

  // Parameterization

  test("fractions run from zero to one strictly increasing", () => {
    const samples = GeoPathSampler.samples(ImmersiveMapGeoPath.make([geoCoordinate(55.75, 37.61), geoCoordinate(37.77, -122.41)]));
    expect(samples.length).toBeGreaterThan(2);
    expect(samples[0]!.fraction).toBe(0);
    expect(samples[samples.length - 1]!.fraction).toBe(1);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]!.fraction).toBeGreaterThan(samples[index - 1]!.fraction);
    }
  });

  test("the sample count grows with the path length and stays bounded", () => {
    const shortPath = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, 0.01)]));
    const longPath = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(-90, 0), geoCoordinate(90, 0)]));
    expect(shortPath.sampleCount).toBe(2);
    expect(longPath.sampleCount).toBeGreaterThan(shortPath.sampleCount);
    expect(longPath.sampleCount).toBeLessThanOrEqual(GeoPathMetrics.maximumSampleCount);
    // 180 degrees at a 0.25 degree step.
    expect(longPath.sampleCount).toBe(721);
  });

  test("a sample follows the great circle of its segment", () => {
    const start = geoCoordinate(55.75, 37.61);
    const end = geoCoordinate(37.77, -122.41);
    const metrics = metricsOf(ImmersiveMapGeoPath.make([start, end]));
    for (const fraction of [0.1, 0.25, 0.5, 0.9]) {
      const expected = GeoGreatCircleMath.coordinate(start, end, fraction);
      const sample = metrics.sample(fraction);
      expectClose(sample.coordinate.latitude, expected.latitude, 1e-9);
      expectClose(sample.coordinate.longitude, expected.longitude, 1e-9);
    }
  });

  /**
   * Waypoints are placed by arc length, not by index: a 2:1 pair of segments
   * puts the middle waypoint at two thirds of the path.
   */
  test("a multi-waypoint path is parameterized by arc length", () => {
    const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, 40), geoCoordinate(0, 60)]));
    expectClose(metrics.sample(2.0 / 3.0).coordinate.longitude, 40, 1e-6);
    expectClose(metrics.sample(1.0 / 3.0).coordinate.longitude, 20, 1e-6);
  });

  // Altitude profile

  test("the altitude profile starts and ends at the base and crests in the middle", () => {
    const path = ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, 90)], {
      baseAltitudeMeters: 1_000,
      peakAltitudeMeters: 400_000,
    });
    expectClose(ImmersiveMapGeoPath.altitudeMeters(path, 0), 1_000, 1e-9);
    expectClose(ImmersiveMapGeoPath.altitudeMeters(path, 1), 1_000, 1e-9);
    expectClose(ImmersiveMapGeoPath.altitudeMeters(path, 0.5), 401_000, 1e-9);
  });

  test("a flat profile keeps the base altitude everywhere", () => {
    const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, 30)], { baseAltitudeMeters: 500 }));
    for (const fraction of [0.0, 0.3, 0.5, 1.0]) {
      expectClose(metrics.sample(fraction).altitudeMeters, 500, 1e-9);
      expectClose(metrics.sample(fraction).pitchDegrees, 0, 1e-9);
    }
  });

  // Derivatives

  test("the heading along the equator points east everywhere", () => {
    const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, 60)]));
    for (const fraction of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      expectClose(metrics.sample(fraction).headingDegrees, 90, 1e-6);
    }
  });

  test("the heading of a street-level path follows its own legs, not the chord across it", () => {
    // About 1.1 km east, then 1.1 km north: one sample step of 0.25 degrees
    // (27.8 km) is longer than the whole path.
    const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(46.5, 11.8), geoCoordinate(46.5, 11.8145), geoCoordinate(46.51, 11.8145)]));
    expectClose(metrics.sample(0.25).headingDegrees, 90, 0.05);
    expectClose(metrics.sample(0.75).headingDegrees, 0, 0.05);
    // The arm is short (50 m, the minimum, on a 2.2 km path): it crosses the
    // corner only within 50 m of it, and 0.47 and 0.53 are some 67 m away.
    expectClose(metrics.sample(0.47).headingDegrees, 90, 0.05);
    expectClose(metrics.sample(0.53).headingDegrees, 0, 0.05);
  });

  test("a short loop's heading goes round with the loop", () => {
    // A circle of about 1.1 km radius, drawn by 72 waypoints.
    const waypoints = Array.from({ length: 73 }, (_, index) => {
      const angle = (index / 72) * 2 * Math.PI;
      return geoCoordinate(46.5 + 0.01 * Math.cos(angle), 11.8 + (0.01 * Math.sin(angle)) / Math.cos((46.5 * Math.PI) / 180));
    });
    const metrics = metricsOf(ImmersiveMapGeoPath.make(waypoints));
    // From the north point the loop runs clockwise: east at the top, south at the right.
    expectClose(metrics.sample(0.01).headingDegrees, 90 + 3.6, 3);
    expectClose(metrics.sample(0.26).headingDegrees, 180 + 3.6, 3);
  });

  test("a long flight keeps the half-step arm it always had", () => {
    // Paris to New York, 5,840 km: 1% of it is longer than half a step, so
    // the arm is the half step, as before the arm took a share of the path.
    const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(48.8566, 2.3522), geoCoordinate(40.7128, -74.006)]));
    expectClose(metrics.derivativeFraction, 0.5 / (metrics.sampleCount - 1), 1e-15);
  });

  test("a model turns round a corner over the same share of any path", () => {
    // The share of the path over which the heading swings from one leg's
    // course to the other's: 2% (1% either side), for a 300 km flight and a
    // 30 km ride alike. A fixed 50 m arm would snap the flight round at once.
    for (const legDegrees of [1.35, 0.135]) {
      const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, legDegrees), geoCoordinate(legDegrees, legDegrees)]));
      const steps = 4000;
      let turning = 0;
      for (let step = 0; step <= steps; step++) {
        const heading = metrics.sample(step / steps).headingDegrees;
        if (heading > 1 && heading < 89) turning++;
      }
      expectClose(turning / steps, 0.02, 0.002);
    }
  });

  test("the pitch climbs on the first half and descends on the second", () => {
    const metrics = metricsOf(ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(0, 90)], { peakAltitudeMeters: 400_000 }));
    expect(metrics.sample(0.1).pitchDegrees).toBeGreaterThan(0);
    expectClose(metrics.sample(0.5).pitchDegrees, 0, 1e-6);
    expect(metrics.sample(0.9).pitchDegrees).toBeLessThan(0);
  });

  test("samples carry a projection basis matching their coordinate", () => {
    const samples = GeoPathSampler.samples(ImmersiveMapGeoPath.make([geoCoordinate(10, 20), geoCoordinate(-10, 40)]));
    const sample = samples[0]!;
    expect(sample.basis).toEqual(GeoProjectionBasis.fromCoordinate(sample.coordinate));
  });
});
