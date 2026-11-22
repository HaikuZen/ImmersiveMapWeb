// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { FrameCameraStateResolver } from "../camera/frame-camera-state-resolver.ts";
import { type CameraFlightRouteStyle, CameraFlightOptions, ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import { type CameraPresentationSettings, defaultCameraPresentationSettings } from "../presentation/camera-presentation-settings.ts";
import { MapPresentationStateController } from "../presentation/map-presentation-state-controller.ts";
import type { ImmersiveMapCameraTourShot } from "../ui/camera/immersive-map-camera-tour-controller.ts";
import { TourVideoTimelineDriver } from "./tour-video-timeline-driver.ts";

/** Ported from the Swift `TourVideoTimelineDriverTests`. */
describe("TourVideoTimelineDriver", () => {
  const start = ImmersiveMapCameraPosition.make(0, 0, 10, 0, 0);
  const settings: CameraPresentationSettings = defaultCameraPresentationSettings;

  function makeShot(options: {
    latitude: number;
    longitude: number;
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration: number;
    routeStyle?: CameraFlightRouteStyle;
    holdAfter?: number;
  }): ImmersiveMapCameraTourShot {
    return {
      position: ImmersiveMapCameraPosition.make(options.latitude, options.longitude, options.zoom ?? 10, options.bearing ?? 0, options.pitch ?? 0),
      options: CameraFlightOptions.make(options.duration, options.routeStyle ?? "mercatorShortestPath", "direct"),
      holdAfter: options.holdAfter ?? 0,
    };
  }

  function makeDriver(shots: ImmersiveMapCameraTourShot[], initialPosition: ImmersiveMapCameraPosition): [TourVideoTimelineDriver, FrameCameraStateResolver] {
    const renderCamera = new FrameCameraStateResolver(settings);
    const presentation = new MapPresentationStateController(settings);
    return [new TourVideoTimelineDriver(shots, initialPosition, settings, renderCamera, presentation), renderCamera];
  }

  // Plan

  test("the plan sums the flight durations and the holds", () => {
    const shots = [makeShot({ latitude: 10, longitude: 10, duration: 2, holdAfter: 0.5 }), makeShot({ latitude: 20, longitude: 20, duration: 1 })];
    const plan = TourVideoTimelineDriver.makePlan(shots, start, settings, 60);
    expect(plan.totalDuration).toBeCloseTo(3.5, 9);
    expect(plan.frameCount).toBe(211);
  });

  test("a degenerate shot collapses to its hold", () => {
    // Flying to where the tour already stands completes at once live: the plan charges the hold alone.
    const shots = [makeShot({ latitude: start.latitudeDegrees, longitude: start.longitudeDegrees, duration: 3, holdAfter: 0.5 })];
    expect(TourVideoTimelineDriver.makePlan(shots, start, settings, 60).totalDuration).toBeCloseTo(0.5, 9);
  });

  test("the plan of no shots is a single frame", () => {
    const plan = TourVideoTimelineDriver.makePlan([], start, settings, 60);
    expect(plan.totalDuration).toBe(0);
    expect(plan.frameCount).toBe(1);
  });

  // Driving

  test("the driver jumps to the initial position", () => {
    const establish = ImmersiveMapCameraPosition.make(35.68, 139.76, 6, 0.2, 0.1);
    const [, renderCamera] = makeDriver([makeShot({ latitude: 10, longitude: 10, duration: 1 })], establish);
    const position = renderCamera.currentCameraPosition();
    expect(position.latitudeDegrees).toBeCloseTo(establish.latitudeDegrees, 6);
    expect(position.longitudeDegrees).toBeCloseTo(establish.longitudeDegrees, 6);
    expect(position.zoom).toBeCloseTo(establish.zoom, 9);
  });

  test("a flight ends on its exact target", () => {
    const target = makeShot({ latitude: 25.2, longitude: 55.27, zoom: 12, bearing: 0.3, pitch: 0.4, duration: 1 });
    const [driver, renderCamera] = makeDriver([target], start);
    driver.advance(0);
    driver.advance(0.5);
    expect(Math.abs(renderCamera.currentCameraPosition().latitudeDegrees - target.position.latitudeDegrees)).toBeGreaterThan(1e-9);
    driver.advance(2);
    const position = renderCamera.currentCameraPosition();
    expect(position.latitudeDegrees).toBeCloseTo(target.position.latitudeDegrees, 9);
    expect(position.longitudeDegrees).toBeCloseTo(target.position.longitudeDegrees, 9);
    expect(position.zoom).toBeCloseTo(target.position.zoom, 9);
    expect(position.bearing).toBeCloseTo(target.position.bearing, 6);
    expect(driver.isFinished).toBe(true);
  });

  test("a frame step past short segments still lands on the last target", () => {
    const shots = [makeShot({ latitude: 5, longitude: 5, duration: 0.001 }), makeShot({ latitude: 6, longitude: 6, duration: 0.001 }), makeShot({ latitude: 7, longitude: 7, duration: 0.001 })];
    const [driver, renderCamera] = makeDriver(shots, start);
    driver.advance(1);
    const position = renderCamera.currentCameraPosition();
    expect(position.latitudeDegrees).toBeCloseTo(7, 9);
    expect(position.longitudeDegrees).toBeCloseTo(7, 9);
    expect(driver.isFinished).toBe(true);
  });

  test("the hold keeps the camera parked on the target", () => {
    const [driver, renderCamera] = makeDriver([makeShot({ latitude: 10, longitude: 10, duration: 1, holdAfter: 1 })], start);
    driver.advance(1.5);
    expect(renderCamera.currentCameraPosition().latitudeDegrees).toBeCloseTo(10, 9);
    expect(driver.isFinished).toBe(false);
    driver.advance(2.5);
    expect(driver.isFinished).toBe(true);
  });

  // Route resolution

  test("the automatic route is the mercator one at a high zoom", () => {
    const highZoomStart = ImmersiveMapCameraPosition.make(35.68, 139.76, 16, 0, 0);
    const positionAtHalf = (routeStyle: CameraFlightRouteStyle): ImmersiveMapCameraPosition => {
      const [driver, renderCamera] = makeDriver([makeShot({ latitude: 25.2, longitude: 55.27, zoom: 16, duration: 1, routeStyle })], highZoomStart);
      driver.advance(0.5);
      return renderCamera.currentCameraPosition();
    };
    const automatic = positionAtHalf("automatic");
    const mercator = positionAtHalf("mercatorShortestPath");
    const greatCircle = positionAtHalf("greatCircle");
    expect(automatic.latitudeDegrees).toBeCloseTo(mercator.latitudeDegrees, 9);
    expect(automatic.longitudeDegrees).toBeCloseTo(mercator.longitudeDegrees, 9);
    expect(Math.abs(automatic.latitudeDegrees - greatCircle.latitudeDegrees)).toBeGreaterThan(1e-6);
  });

  test("the automatic route is the great circle at a low zoom", () => {
    const lowZoomStart = ImmersiveMapCameraPosition.make(35.68, 139.76, 1.5, 0, 0);
    const positionAtHalf = (routeStyle: CameraFlightRouteStyle): ImmersiveMapCameraPosition => {
      const [driver, renderCamera] = makeDriver([makeShot({ latitude: 25.2, longitude: 55.27, zoom: 1.5, duration: 1, routeStyle })], lowZoomStart);
      driver.advance(0.5);
      return renderCamera.currentCameraPosition();
    };
    const automatic = positionAtHalf("automatic");
    const greatCircle = positionAtHalf("greatCircle");
    expect(automatic.latitudeDegrees).toBeCloseTo(greatCircle.latitudeDegrees, 9);
    expect(automatic.longitudeDegrees).toBeCloseTo(greatCircle.longitudeDegrees, 9);
  });

  // Constraints

  test("the applied states respect the pitch constraints", () => {
    const [driver, renderCamera] = makeDriver([makeShot({ latitude: 10, longitude: 10, zoom: 16, pitch: 3, duration: 1 })], start);
    let observedMaximumPitch = 0;
    for (let step = 0; step <= 60; step++) {
      driver.advance((step / 60) * 2);
      observedMaximumPitch = Math.max(observedMaximumPitch, renderCamera.currentCameraPosition().pitch);
    }
    expect(observedMaximumPitch).toBeLessThanOrEqual(settings.camera.maximumPitch + 1e-6);
  });

  test("no shots finish at once", () => {
    const [driver, renderCamera] = makeDriver([], start);
    expect(driver.isFinished).toBe(true);
    driver.advance(1);
    expect(renderCamera.currentCameraPosition().latitudeDegrees).toBeCloseTo(start.latitudeDegrees, 9);
  });
});
