// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { geoCoordinate } from "./geo-coordinate.ts";
import { GeoGreatCircleMath } from "./geo-great-circle-math.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/**
 * Great-circle interpolation and forward azimuth. The edge cases
 * (antimeridian, poles, antipodes) the scene model moves rely on are pinned
 * here.
 */
describe("GeoGreatCircleMath", () => {
  // Interpolation

  test("progress bounds return the endpoints exactly", () => {
    const start = geoCoordinate(12.5, -30.25);
    const target = geoCoordinate(-40.0, 150.0);
    expect(GeoGreatCircleMath.coordinate(start, target, 0)).toEqual(start);
    expect(GeoGreatCircleMath.coordinate(start, target, 1)).toEqual(target);
    expect(GeoGreatCircleMath.coordinate(start, target, -5)).toEqual(start);
    expect(GeoGreatCircleMath.coordinate(start, target, 5)).toEqual(target);
  });

  test("the equator's midpoint stays on the equator", () => {
    const mid = GeoGreatCircleMath.coordinate(geoCoordinate(0, 0), geoCoordinate(0, 60), 0.5);
    expectClose(mid.latitude, 0, 1e-9);
    expectClose(mid.longitude, 30, 1e-9);
  });

  /** A lat/lon lerp would run the long way around the globe here. */
  test("the antimeridian takes the short arc", () => {
    const mid = GeoGreatCircleMath.coordinate(geoCoordinate(0, 179), geoCoordinate(0, -179), 0.5);
    expectClose(mid.latitude, 0, 1e-9);
    expectClose(Math.abs(mid.longitude), 180, 1e-9);
  });

  test("a pole crossing keeps the midpoint on the meridian", () => {
    const mid = GeoGreatCircleMath.coordinate(geoCoordinate(80, 0), geoCoordinate(80, 180), 0.5);
    expectClose(mid.latitude, 90, 1e-6);
  });

  test("antipodal endpoints fall back to a lat/lon lerp", () => {
    const mid = GeoGreatCircleMath.coordinate(geoCoordinate(10, 0), geoCoordinate(-10, 180), 0.5);
    expect(Number.isNaN(mid.latitude)).toBe(false);
    expect(Number.isNaN(mid.longitude)).toBe(false);
    expectClose(mid.latitude, 0, 1e-9);
  });

  test("coincident endpoints return the start", () => {
    const point = geoCoordinate(33.3, 44.4);
    expect(GeoGreatCircleMath.coordinate(point, point, 0.5)).toEqual(point);
  });

  // Central angle

  test("the central angle is accurate for short arcs", () => {
    // One kilometre along the equator: acos(dot) in Float would collapse this
    // to noise, which is why the half-chord form is used.
    const oneKilometreDegrees = 1000.0 / (ImmersiveMapProjection.earthCircumferenceMeters / 360.0);
    const angle = GeoGreatCircleMath.centralAngle(geoCoordinate(0, 0), geoCoordinate(0, oneKilometreDegrees));
    expectClose(angle, (oneKilometreDegrees * Math.PI) / 180.0, 1e-12);
  });

  test("the central angle of antipodes is pi", () => {
    expectClose(GeoGreatCircleMath.centralAngle(geoCoordinate(0, 0), geoCoordinate(0, 180)), Math.PI, 1e-9);
  });

  // Bearing

  test("the bearing's cardinal directions", () => {
    const origin = geoCoordinate(0, 0);
    expectClose(GeoGreatCircleMath.bearingDegrees(origin, geoCoordinate(1, 0)), 0, 1e-9);
    expectClose(GeoGreatCircleMath.bearingDegrees(origin, geoCoordinate(0, 1)), 90, 1e-9);
    expectClose(GeoGreatCircleMath.bearingDegrees(origin, geoCoordinate(-1, 0)), 180, 1e-9);
    expectClose(GeoGreatCircleMath.bearingDegrees(origin, geoCoordinate(0, -1)), 270, 1e-9);
  });

  test("the bearing across the antimeridian points east", () => {
    expectClose(GeoGreatCircleMath.bearingDegrees(geoCoordinate(0, 179.9), geoCoordinate(0, -179.9)), 90, 1e-9);
  });

  test("the bearing of coincident points is zero", () => {
    const point = geoCoordinate(5, 5);
    expectClose(GeoGreatCircleMath.bearingDegrees(point, point), 0, 1e-12);
  });
});
