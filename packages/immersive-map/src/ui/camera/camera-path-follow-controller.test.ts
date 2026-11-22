// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CameraFlightOptions, ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../../camera/render-camera-pose-resolver.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { defaultRenderLoopSettings } from "../../configuration/view-settings.ts";
import { type GeoCoordinate, geoCoordinate } from "../../geo/geo-coordinate.ts";
import { GeoPathMetrics } from "../../geo/geo-path-sampler.ts";
import { GeoProjectionBasis } from "../../geo/geo-projection-basis.ts";
import { GeoScreenProjectionFrameConstants, GeoScreenProjectionMath } from "../../geo/geo-screen-projection-math.ts";
import { ImmersiveMapGeoPath } from "../../geo/immersive-map-geo-path.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import { PresentationStateResolver } from "../../presentation/presentation-state-resolver.ts";
import { MapGestureController } from "../gestures/map-gesture-controller.ts";
import { RenderLoopDriver } from "../render-loop-pacing.ts";
import { ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";
import { ImmersiveMapCameraFollowBearing, ImmersiveMapCameraFollowOptions } from "./immersive-map-camera-follow-options.ts";
import { createImmersiveMapCameraRuntimes } from "./immersive-map-camera-runtimes.ts";

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/** A map's camera side on a fake render loop, the stand-in for the Swift test's host view. */
function makeMap(camera: ImmersiveMapCameraController, cameraPosition: ImmersiveMapCameraPosition | null) {
  const render = new RenderLoopDriver({
    configuration: defaultRenderLoopSettings,
    renderFrame: () => true,
    scheduler: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined },
    now: () => 0,
  });
  const runtimes = createImmersiveMapCameraRuntimes({
    settings: ImmersiveMapSettings.default,
    initialCameraPosition: cameraPosition,
    cameraController: camera,
    render,
    viewportSize: () => [320, 240],
    now: () => 0,
  });
  const listeners = new EventTarget();
  const gestures = new MapGestureController({
    surface: Object.assign(listeners, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }), style: { touchAction: "" } }),
    host: runtimes,
    now: () => 0,
  });
  return { ...runtimes, render, gestures };
}

const overview = ImmersiveMapCameraPosition.make(0, 0, 2.0);
const path = ImmersiveMapGeoPath.between(geoCoordinate(0, 0), geoCoordinate(0, 40));
const unchanged = (smoothingHalfLife: number): ImmersiveMapCameraFollowOptions =>
  ImmersiveMapCameraFollowOptions.make({ bearing: ImmersiveMapCameraFollowBearing.unchanged, smoothingHalfLife });

function position(camera: ImmersiveMapCameraController): ImmersiveMapCameraPosition {
  const value = camera.currentCameraPosition();
  expect(value).not.toBeNull();
  return value!;
}

/** A short path from the equator running on the given compass course. */
function coursePath(course: number): ImmersiveMapGeoPath {
  const radians = (course * Math.PI) / 180;
  return ImmersiveMapGeoPath.make([geoCoordinate(0, 0), geoCoordinate(Math.cos(radians) * 0.4, Math.sin(radians) * 0.4)]);
}

function screenPoint(coordinate: GeoCoordinate, at: ImmersiveMapCameraPosition): Vec2 | null {
  const center = ImmersiveMapProjection.worldMercator((at.latitudeDegrees * Math.PI) / 180, (at.longitudeDegrees * Math.PI) / 180);
  const cameraState = ImmersiveMapCameraState.make(center, at.zoom, at.bearing, at.pitch);
  const presentation = PresentationStateResolver.resolve(cameraState, ImmersiveMapSettings.default.presentation);
  const renderCamera = new RenderCamera();
  renderCamera.recalculateProjection(320 / 240);
  new RenderCameraPoseResolver().updateIfNeeded(renderCamera, cameraState, presentation.presentationState.transition);
  const constants = new GeoScreenProjectionFrameConstants(320, 240, { matrix: renderCamera.cameraMatrix!.slice(), eye: renderCamera.eye }, presentation);
  const projected = GeoScreenProjectionMath.project(GeoProjectionBasis.fromCoordinate(coordinate), constants);
  return projected.visible === 0 ? null : [projected.positionX, projected.positionY];
}

/**
 * Swift `CameraPathFollowControllerTests`: a camera travelling along a path,
 * driven with injected times. Where it ends up, who wins when something else
 * takes the camera, and that the completion fires exactly once on every exit.
 */
describe("CameraPathFollowController", () => {
  // Traversal

  test("the camera travels from the first waypoint to the last", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    let completed: boolean | null = null;
    // Zero smoothing pins the camera on the path point, which is what makes
    // the endpoint exact and the assertion meaningful.
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", unchanged(0), (finished) => (completed = finished), 0);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(true);

    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(0);
    expectClose(position(camera).longitudeDegrees, 0, 1e-4);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(5);
    // easeOut at the half: 1 - 0.5^3 of the way.
    expectClose(position(camera).longitudeDegrees, 40 * 0.875, 1e-3);
    expect(completed).toBeNull();
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(10);
    expectClose(position(camera).longitudeDegrees, 40, 1e-3);
    expect(completed).toBe(true);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
  });

  test("a linear curve is halfway at the half", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "linear", unchanged(0), null, 0);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(5);
    expectClose(position(camera).longitudeDegrees, 20, 1e-3);
  });

  /** Zoom and pitch are left alone unless the options name them, so an app can keep zooming while the camera travels. */
  test("unset options leave the zoom alone", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    map.cameraAnimationRuntime.startCameraPathFollow(path, 4, "easeOut", unchanged(0), null, 0);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(2);
    expectClose(position(camera).zoom, overview.zoom, 1e-6);
  });

  test("a requested zoom is reached by the end", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    const options = ImmersiveMapCameraFollowOptions.make({ zoom: 3.5, bearing: ImmersiveMapCameraFollowBearing.unchanged, smoothingHalfLife: 0 });
    map.cameraAnimationRuntime.startCameraPathFollow(path, 4, "easeOut", options, null, 0);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(4);
    expectClose(position(camera).zoom, 3.5, 1e-6);
  });

  /** The smoothed camera trails the point instead of snapping onto it. */
  test("smoothing makes the camera trail the point", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "linear", unchanged(0.5), null, 0);
    let time = 0;
    while (time < 5) {
      time += 1 / 60;
      map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(time);
    }
    const trailing = position(camera).longitudeDegrees;
    expect(trailing).toBeGreaterThan(0);
    expect(trailing, "The smoothed camera must lag the point it chases").toBeLessThan(20);
  });

  // Course

  /**
   * The documented promise of `course` is that the direction of travel points
   * up the screen: a point further along the path is projected and checked
   * for where it actually lands.
   */
  test("the course mode puts the direction of travel up the screen", () => {
    for (const [name, course] of [
      ["east", 90],
      ["west", 270],
      ["north", 0],
      ["south", 180],
    ] as const) {
      const camera = new ImmersiveMapCameraController();
      const map = makeMap(camera, ImmersiveMapCameraPosition.make(0, 0, 8));
      const travelled = coursePath(course);
      map.cameraAnimationRuntime.startCameraPathFollow(
        travelled,
        10,
        "easeOut",
        ImmersiveMapCameraFollowOptions.make({ bearing: ImmersiveMapCameraFollowBearing.course, smoothingHalfLife: 0 }),
        null,
        0,
      );
      map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(5);

      const at = position(camera);
      const metrics = GeoPathMetrics.make(travelled)!;
      const center = screenPoint(metrics.sample(0.5).coordinate, at)!;
      const ahead = screenPoint(metrics.sample(0.6).coordinate, at)!;
      expect(ahead[1], `Travelling ${name}, the point ahead must be up the screen`).toBeGreaterThan(center[1]);
      expectClose(ahead[0], center[0], Math.abs(ahead[1] - center[1]) * 0.05, `Travelling ${name}, the course must be straight up, not sideways`);
    }
  });

  // Completion and precedence

  test("a cancel completes with false exactly once", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    const calls: boolean[] = [];
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, (finished) => calls.push(finished), 0);
    camera.cancelFollow();
    camera.cancelFollow();
    expect(calls).toEqual([false]);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
  });

  /** A flight is a direct camera command: it takes the camera and resolves the traversal. */
  test("starting a flight cancels the follow", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    let followCompleted: boolean | null = null;
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, (finished) => (followCompleted = finished), 0);
    camera.fly(ImmersiveMapCameraPosition.make(10, 10, 3), CameraFlightOptions.make(1));
    expect(followCompleted).toBe(false);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(true);
  });

  test("starting a second follow supersedes the first", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    let first: boolean | null = null;
    let second: boolean | null = null;
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, (finished) => (first = finished), 0);
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, (finished) => (second = finished), 1);
    expect(first).toBe(false);
    expect(second).toBeNull();
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(true);
  });

  /** The user taking the camera wins, exactly as it does over a flight. */
  test("user interaction cancels the follow", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    let completed: boolean | null = null;
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, (finished) => (completed = finished), 0);
    map.gestures.setPanInteractionActiveForTesting(true);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(1);
    expect(completed).toBe(false);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
  });

  test("a degenerate path completes with false without moving the camera", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    const before = position(camera);
    let completed: boolean | null = null;
    const point = geoCoordinate(10, 10);
    map.cameraAnimationRuntime.startCameraPathFollow(ImmersiveMapGeoPath.make([point, point]), 10, "easeOut", ImmersiveMapCameraFollowOptions.default, (finished) => (completed = finished), 0);
    expect(completed).toBe(false);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
    expectClose(position(camera).longitudeDegrees, before.longitudeDegrees, 1e-9);
  });

  test("a zero duration jumps to the end and completes", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    let completed: boolean | null = null;
    map.cameraAnimationRuntime.startCameraPathFollow(path, 0, "easeOut", unchanged(0), (finished) => (completed = finished), 0);
    expect(completed).toBe(true);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
    expectClose(position(camera).longitudeDegrees, 40, 1e-3);
  });

  /** A follow issued from inside a superseded completion must win: the call still unwinding must not overwrite it. */
  test("a follow started from a superseded completion survives", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    const secondPath = ImmersiveMapGeoPath.between(geoCoordinate(0, 0), geoCoordinate(40, 0));
    let innerCompleted: boolean | null = null;
    map.cameraAnimationRuntime.startCameraPathFollow(
      path,
      10,
      "easeOut",
      ImmersiveMapCameraFollowOptions.default,
      () => map.cameraAnimationRuntime.startCameraPathFollow(secondPath, 10, "easeOut", unchanged(0), (finished) => (innerCompleted = finished), 1),
      0,
    );
    // Superseding the first fires its completion, which starts the second.
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, null, 1);

    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(true);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(11);
    expect(innerCompleted, "the traversal started from the completion must run").toBe(true);
    expectClose(position(camera).latitudeDegrees, 40, 1e-2);
  });

  /** A stall must not strand the camera: the frame that ends the traversal pays back the catch-up the missed frames skipped. */
  test("a stalled final frame still lands near the destination", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", unchanged(0.35), null, 0);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(0);
    // One frame, ten seconds later: the loop was asleep the whole traversal.
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(10);
    expectClose(position(camera).longitudeDegrees, 40, 0.5);
    expect(map.cameraAnimationRuntime.isCameraPathFollowActive).toBe(false);
  });

  // Render loop

  test("a follow keeps the render loop awake until it finishes", () => {
    const camera = new ImmersiveMapCameraController();
    const map = makeMap(camera, overview);
    map.cameraAnimationRuntime.startCameraPathFollow(path, 10, "easeOut", ImmersiveMapCameraFollowOptions.default, null, 0);
    expect(map.render.pacing.isCameraAnimationRenderingActive).toBe(true);
    map.cameraAnimationRuntime.advanceCameraPathFollowIfNeeded(10);
    expect(map.render.pacing.isCameraAnimationRenderingActive).toBe(false);
  });
});

/**
 * Swift `CameraJumpAfterGestureTests`. A controller's `jump` goes where it
 * says every time, also back to the previous jump's target after the user
 * dragged the map away. The dedup stays on the declared position alone,
 * which may be declared again unchanged.
 */
describe("Camera jump after a gesture", () => {
  const home = ImmersiveMapCameraPosition.make(52.52, 13.405, 12, 0, 0);

  test("a jump back to the previous target after a pan moves the camera", () => {
    const controller = new ImmersiveMapCameraController();
    const map = makeMap(controller, null);
    controller.jump(home);
    map.cameraRuntime.panCamera(200, 120);
    const panned = map.cameraRuntime.currentCameraPosition()!;
    expect(Math.abs(panned.latitudeDegrees - home.latitudeDegrees) + Math.abs(panned.longitudeDegrees - home.longitudeDegrees)).toBeGreaterThan(1e-4);

    controller.jump(home);
    const after = map.cameraRuntime.currentCameraPosition()!;
    expectClose(after.latitudeDegrees, home.latitudeDegrees, 1e-6);
    expectClose(after.longitudeDegrees, home.longitudeDegrees, 1e-6);
    expect(map.render.pacing.renderingReasonDescription).toContain("external camera drive");
  });

  test("a declared position repeated after a pan does not snap back", () => {
    const map = makeMap(new ImmersiveMapCameraController(), null);
    map.commandHandler.applyCameraPosition(home);
    map.cameraRuntime.panCamera(200, 120);
    const panned = map.cameraRuntime.currentCameraPosition()!;
    map.commandHandler.applyCameraPosition(home);
    const after = map.cameraRuntime.currentCameraPosition()!;
    expectClose(after.latitudeDegrees, panned.latitudeDegrees, 1e-9);
    expectClose(after.longitudeDegrees, panned.longitudeDegrees, 1e-9);
  });
});
