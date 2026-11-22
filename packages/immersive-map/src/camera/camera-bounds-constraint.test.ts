// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type CameraBounds, CameraBoundsEdgeBehavior, cameraBounds, cameraSettings, PullCurve } from "../configuration/camera-settings.ts";
import { geoCoordinate } from "../geo/geo-coordinate.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec2 } from "../math/vec.ts";
import { CameraBoundsConstraint, pullCurveValue } from "./camera-bounds-constraint.ts";
import { CameraStateController } from "./camera-state-controller.ts";
import { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function world(latitude: number, longitude: number): Vec2 {
  return ImmersiveMapProjection.worldMercator((latitude * Math.PI) / 180, (longitude * Math.PI) / 180);
}

function degrees(point: Vec2): [latitude: number, longitude: number] {
  return [
    (ImmersiveMapProjection.latitudeFromNormalizedWorldY(point[1]) * 180) / Math.PI,
    (ImmersiveMapProjection.longitudeFromNormalizedWorldX(point[0]) * 180) / Math.PI,
  ];
}

function expectPoint(actual: Vec2, expected: Vec2): void {
  expectClose(actual[0], expected[0], 1e-12);
  expectClose(actual[1], expected[1], 1e-12);
}

const moscow: CameraBounds = cameraBounds({
  southWest: geoCoordinate(55.57, 37.36),
  northEast: geoCoordinate(55.92, 37.86),
  pullZoomRange: { lowerBound: 1, upperBound: 2 },
  pullCurve: PullCurve.linear,
});

/** A region shrunk to the point (0, 0), strict from zoom 2: at zoom 5 the area is the world point (0.5, 0.5). */
const equatorPoint: CameraBounds = cameraBounds({ southWest: geoCoordinate(0, 0), northEast: geoCoordinate(0, 0) });

function elasticController(pullProgression: number): CameraStateController {
  const bounds = { ...moscow, edgeBehavior: CameraBoundsEdgeBehavior.elastic({ maximumStretch: 200, pullHalfLife: 0.35, pullProgression }) };
  return new CameraStateController(cameraSettings({ bounds }));
}

describe("CameraBoundsConstraint", () => {
  test("the globe below the pull range turns freely", () => {
    const constraint = new CameraBoundsConstraint(moscow);
    const sydney = world(-33.87, 151.21);
    expectPoint(constraint.apply(sydney, 0), sydney);
    expectPoint(constraint.apply(sydney, 1), sydney);
  });

  /** Halfway through a linear pull the reachable area has closed half of the way from the edge of the world to the region. */
  test("a linear pull closes halfway in the middle of the range", () => {
    const constraint = new CameraBoundsConstraint({ ...moscow, southWest: geoCoordinate(0, 0), northEast: geoCoordinate(0, 0) });
    const held = constraint.apply([0.9, 0.1], 1.5);
    expectClose(held[0], 0.5 + 0.25, 1e-9);
    expectClose(held[1], 0.5 * 0.5, 1e-9);
  });

  test("the center is inside the region from the upper bound on", () => {
    const constraint = new CameraBoundsConstraint(moscow);
    const paris = world(48.86, 2.35);
    for (const zoom of [2.0, 14.0]) {
      const [latitude, longitude] = degrees(constraint.apply(paris, zoom));
      expectClose(latitude, 55.57, 0.0001);
      expectClose(longitude, 37.36, 0.0001);
    }
  });

  test("a center inside the region is left alone", () => {
    const kremlin = world(55.75, 37.62);
    expectPoint(new CameraBoundsConstraint(moscow).apply(kremlin, 18), kremlin);
  });

  test("equal bounds switch at that zoom", () => {
    const constraint = new CameraBoundsConstraint({ ...moscow, pullZoomRange: { lowerBound: 0, upperBound: 0 } });
    const [latitude, longitude] = degrees(constraint.apply(world(-33.87, 151.21), 0));
    expectClose(latitude, 55.57, 0.0001);
    expectClose(longitude, 37.86, 0.0001);
  });

  test("a region across the antimeridian clamps the short way", () => {
    const chukotka = cameraBounds({ southWest: geoCoordinate(64, 170), northEast: geoCoordinate(68, -170) });
    const constraint = new CameraBoundsConstraint(chukotka);
    expectClose(degrees(constraint.apply(world(66, 179), 10))[1], 179, 0.0001);
    expectClose(degrees(constraint.apply(world(66, -160), 10))[1], -170, 0.0001);
    expectClose(degrees(constraint.apply(world(66, 160), 10))[1], 170, 0.0001);
  });

  /**
   * With a hard edge, zooming in far from the region draws the center toward
   * it, so the controller re-applies the bounds after a zoom, not only after
   * a pan.
   */
  test("a hard edge zooming in draws the center to the region", () => {
    const controller = new CameraStateController(cameraSettings({ bounds: { ...moscow, edgeBehavior: CameraBoundsEdgeBehavior.hard } }));
    controller.setCameraPosition(ImmersiveMapCameraPosition.make(48.86, 2.35, 0, 0, 0));
    expectClose(controller.getLatLonDeg().lonDeg, 2.35, 0.0001);
    controller.zoomByDelta(14);
    const position = controller.getLatLonDeg();
    expectClose(position.latDeg, 55.57, 0.05);
    expectClose(position.lonDeg, 37.36, 0.05);
  });

  // Elastic edge

  test("the stretch is free up to the edge and damped past it", () => {
    const constraint = new CameraBoundsConstraint(equatorPoint);
    const stretch = 0.1;
    expectClose(constraint.resist([0.5, 0.5], [0.5, 0.5], 5, stretch)[0], 0.5, 1e-12);
    // A drag of one reach past the edge shows half of it: d = L u / (L + u).
    expectClose(constraint.resist([0.5, 0.5], [0.6, 0.5], 5, stretch)[0], 0.55, 1e-12);
    // The same drag in ten steps lands at the same point: the band keeps no
    // state between moves.
    let stepped: Vec2 = [0.5, 0.5];
    for (let index = 0; index < 10; index++) {
      stepped = constraint.resist(stepped, [stepped[0] + 0.01, stepped[1]], 5, stretch);
    }
    expectClose(stepped[0], 0.55, 1e-9);
  });

  test("the stretch never reaches its reach", () => {
    const constraint = new CameraBoundsConstraint(equatorPoint);
    let center: Vec2 = [0.5, 0.5];
    for (let index = 0; index < 1000; index++) {
      center = constraint.resist(center, [center[0], center[1] + 0.05], 5, 0.1);
    }
    expect(center[1]).toBeLessThan(0.6);
    expect(center[1]).toBeGreaterThan(0.59);
  });

  test("a move back toward the area is free", () => {
    const back = new CameraBoundsConstraint(equatorPoint).resist([0.58, 0.5], [0.53, 0.5], 5, 0.1);
    expectClose(back[0], 0.53, 1e-12);
  });

  /** A zoom can leave the center farther out than the band reaches. A drag outward then does nothing rather than snapping it in. */
  test("a center beyond the reach moves no further out", () => {
    const held = new CameraBoundsConstraint(equatorPoint).resist([0.8, 0.5], [0.85, 0.5], 5, 0.1);
    expectClose(held[0], 0.8, 1e-12);
  });

  test("the elastic controller lets a zoom leave the center and pulls it back", () => {
    const controller = elasticController(2);
    controller.setCameraPosition(ImmersiveMapCameraPosition.make(48.86, 2.35, 14, 0, 0));
    expectClose(controller.getLatLonDeg().lonDeg, 2.35, 0.0001);

    let previous = controller.getLatLonDeg().lonDeg;
    let frames = 0;
    while (controller.advanceBoundsPull(1.0 / 60)) {
      const longitude = controller.getLatLonDeg().lonDeg;
      expect(longitude, "The pull only ever moves toward the region").toBeGreaterThanOrEqual(previous);
      previous = longitude;
      frames += 1;
      expect(frames, "The pull must settle").toBeLessThan(600);
    }
    // Far out the pull is at its cap, so it is not a one-frame jump.
    expect(frames).toBeGreaterThan(10);
    const settled = controller.getLatLonDeg();
    expectClose(settled.latDeg, 55.57, 0.0001);
    expectClose(settled.lonDeg, 37.36, 0.0001);
    expect(controller.advanceBoundsPull(1.0 / 60)).toBe(false);
  });

  /** Near the edge the pull closes half the gap every `pullHalfLife`, and with a progression it closes a far gap faster, as a share of that gap. */
  test("the pull grows with the distance", () => {
    function closedShare(pointsOut: number, progression: number): number {
      const controller = elasticController(progression);
      // The region's west edge at zoom 14, `pointsOut` screen points out.
      const worldPerPoint = (0.5 * 0.05 * 0.5 * 0.1) / 2.0 ** 14;
      const edge = world(55.75, 37.36);
      controller.setCameraState(ImmersiveMapCameraState.make([edge[0] - pointsOut * worldPerPoint, edge[1]], 14, 0, 0));
      const before = edge[0] - controller.cameraState.centerWorldMercator[0];
      controller.advanceBoundsPull(0.35);
      const after = edge[0] - controller.cameraState.centerWorldMercator[0];
      return 1 - after / before;
    }
    expectClose(closedShare(1, 2), 0.5, 0.02);
    expectClose(closedShare(200, 0), 0.5, 0.001);
    // (1 + 200 / 200)^2 = 4 half-lives in one pullHalfLife.
    expectClose(closedShare(200, 2), 1 - 1.0 / 16, 0.001);
  });

  test("the preset curves meet their ends and shape", () => {
    for (const curve of [PullCurve.linear, PullCurve.easeIn, PullCurve.easeOut, PullCurve.easeInOut]) {
      expectClose(pullCurveValue(curve, 0), 0, 1e-9);
      expectClose(pullCurveValue(curve, 1), 1, 1e-9);
    }
    expectClose(pullCurveValue(PullCurve.linear, 0.3), 0.3, 1e-6);
    expectClose(pullCurveValue(PullCurve.easeInOut, 0.5), 0.5, 1e-6);
    expect(pullCurveValue(PullCurve.easeIn, 0.5)).toBeLessThan(0.5);
    expect(pullCurveValue(PullCurve.easeOut, 0.5)).toBeGreaterThan(0.5);
  });

  /** A curve whose y leaves 0...1 overshoots, but the pull never opens past the whole world or closes past the region. */
  test("an overshooting curve is clamped to the region", () => {
    const bounds = { ...moscow, pullCurve: PullCurve.make(0.3, 1.8, 0.6, 1.4) };
    expect(pullCurveValue(bounds.pullCurve, 0.5)).toBeGreaterThan(1);
    expect(new CameraBoundsConstraint(bounds).pull(1.5)).toBe(1);
  });
});
