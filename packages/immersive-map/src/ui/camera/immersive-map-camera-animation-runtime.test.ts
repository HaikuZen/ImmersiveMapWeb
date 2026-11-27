// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CameraFlightOptions, ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { defaultRenderLoopSettings } from "../../configuration/view-settings.ts";
import { RenderLoopDriver } from "../render-loop-pacing.ts";
import { ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";
import { createImmersiveMapCameraRuntimes } from "./immersive-map-camera-runtimes.ts";
import { ImmersiveMapCameraTourController, ImmersiveMapCameraTourShot } from "./immersive-map-camera-tour-controller.ts";

function makeMap(cameraPosition: ImmersiveMapCameraPosition, settings: ImmersiveMapSettings = ImmersiveMapSettings.default) {
  let time = 0;
  const render = new RenderLoopDriver({
    configuration: defaultRenderLoopSettings,
    renderFrame: () => true,
    scheduler: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined },
    now: () => time,
  });
  const camera = new ImmersiveMapCameraController();
  const runtimes = createImmersiveMapCameraRuntimes({
    settings,
    initialCameraPosition: cameraPosition,
    cameraController: camera,
    render,
    viewportSize: () => [320, 240],
    now: () => time,
  });
  /** Runs the frames for `seconds` at 60 fps, as the render loop would. */
  const run = (seconds: number): void => {
    const end = time + seconds;
    while (time < end) {
      time += 1 / 60;
      runtimes.cameraAnimationRuntime.advanceAnimationsIfNeeded(time);
    }
  };
  return { ...runtimes, camera, render, run };
}

/** The camera's time-based animations, driven frame by frame on an injected clock. */
describe("ImmersiveMapCameraAnimationRuntime", () => {
  test("a flight arrives, completes with true and lets the loop rest", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    let finished: boolean | null = null;
    const positions: ImmersiveMapCameraPosition[] = [];
    map.camera.onCameraPositionChanged = (position) => positions.push(position);
    map.camera.fly(ImmersiveMapCameraPosition.make(52.52, 13.405, 13), CameraFlightOptions.make(1), (value) => (finished = value));
    expect(map.render.pacing.isCameraAnimationRenderingActive).toBe(true);
    map.run(1.2);
    expect(finished).toBe(true);
    const at = map.camera.currentCameraPosition()!;
    expect(at.latitudeDegrees).toBeCloseTo(52.52, 6);
    expect(at.longitudeDegrees).toBeCloseTo(13.405, 6);
    expect(at.zoom).toBeCloseTo(13, 6);
    expect(positions.length).toBeGreaterThan(30);
    expect(map.render.pacing.isCameraAnimationRenderingActive).toBe(false);
  });

  test("a flight to where the camera is completes at once", () => {
    const here = ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12);
    const map = makeMap(here);
    let finished: boolean | null = null;
    map.camera.fly(here, CameraFlightOptions.default, (value) => (finished = value));
    expect(finished).toBe(true);
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(false);
  });

  test("a cancelled flight completes with false once", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    const calls: boolean[] = [];
    map.camera.fly(ImmersiveMapCameraPosition.make(52.52, 13.405, 13), CameraFlightOptions.make(1), (value) => calls.push(value));
    map.camera.cancelFlight();
    map.camera.cancelFlight();
    expect(calls).toEqual([false]);
  });

  test("an angle target is eased toward and the follow ends on it", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    map.camera.setCameraAngleTarget(0.5, 0.8);
    map.run(0.03);
    const midway = map.cameraRuntime.currentCameraState()!;
    expect(midway.pitch).toBeGreaterThan(0);
    expect(midway.pitch).toBeLessThan(0.8);
    map.run(2);
    const settled = map.cameraRuntime.currentCameraState()!;
    expect(settled.pitch).toBeCloseTo(0.8, 3);
    expect(settled.bearing).toBeCloseTo(0.5, 3);
    expect(map.render.pacing.isCameraAnimationRenderingActive).toBe(false);
  });

  test("the upright pull straightens a turned and tilted globe", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(20, 10, 1, 1.2, 0.6));
    map.run(3);
    const state = map.cameraRuntime.currentCameraState()!;
    expect(state.bearing).toBeCloseTo(0, 6);
    expect(state.pitch).toBeCloseTo(0, 6);
    expect(map.render.pacing.isCameraAnimationRenderingActive).toBe(false);
  });

  test("the elastic bounds pull the center back into the region", () => {
    const settings = ImmersiveMapSettings.default.cameraSettings({
      ...ImmersiveMapSettings.default.camera,
      bounds: {
        southWest: { latitude: 55.57, longitude: 37.36 },
        northEast: { latitude: 55.92, longitude: 37.86 },
        pullZoomRange: { lowerBound: 1, upperBound: 2 },
        pullCurve: { x1: 0, y1: 0, x2: 1, y2: 1 },
        edgeBehavior: { kind: "elastic", maximumStretch: 200, pullHalfLife: 0.35, pullProgression: 2 },
      },
    });
    const map = makeMap(ImmersiveMapCameraPosition.make(48.86, 2.35, 14), settings);
    map.run(5);
    const at = map.camera.currentCameraPosition()!;
    expect(at.latitudeDegrees).toBeCloseTo(55.57, 3);
    expect(at.longitudeDegrees).toBeCloseTo(37.36, 3);
  });

  test("a jump cancels the running flight", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    let finished: boolean | null = null;
    map.camera.fly(ImmersiveMapCameraPosition.make(52.52, 13.405, 13), CameraFlightOptions.make(1), (value) => (finished = value));
    map.camera.jump(ImmersiveMapCameraPosition.make(40.73, -73.98, 11));
    expect(finished).toBe(false);
    expect(map.camera.currentCameraPosition()!.latitudeDegrees).toBeCloseTo(40.73, 6);
  });

  test("the snapshot carries the limits in force", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    const snapshot = map.camera.currentCameraSnapshot()!;
    expect(snapshot.isSphericalSurfaceActive).toBe(false);
    expect(snapshot.pitchLimits.maximum).toBeCloseTo(ImmersiveMapSettings.default.camera.maximumPitch, 9);
    expect(snapshot.planningZoom).toBe(12);
  });
});

/** The tour chains flights through their completions and stops for the user. */
describe("ImmersiveMapCameraTourController", () => {
  const flushPromises = async (): Promise<void> => {
    for (let index = 0; index < 5; index++) {
      await Promise.resolve();
    }
  };

  test("a tour flies its shots in order and finishes once", async () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    const tour = new ImmersiveMapCameraTourController(map.camera, async () => undefined);
    let finished = 0;
    tour.start(
      [
        ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(52.52, 13.405, 12), CameraFlightOptions.make(0.5)),
        ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(41.9028, 12.4964, 12), CameraFlightOptions.make(0.5), 1),
      ],
      { onFinished: () => (finished += 1) },
    );
    expect(tour.isRunning).toBe(true);
    map.run(0.7);
    await flushPromises();
    expect(map.camera.currentCameraPosition()!.latitudeDegrees).toBeCloseTo(52.52, 6);
    map.run(0.7);
    await flushPromises();
    expect(map.camera.currentCameraPosition()!.latitudeDegrees).toBeCloseTo(41.9028, 6);
    expect(finished).toBe(1);
    expect(tour.isRunning).toBe(false);
  });

  test("a user interaction stops the tour and its flight", async () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    const tour = new ImmersiveMapCameraTourController(map.camera, async () => undefined);
    let finished = 0;
    tour.start([ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(52.52, 13.405, 12), CameraFlightOptions.make(2))], {
      onFinished: () => (finished += 1),
    });
    map.run(0.2);
    map.interactionRuntime.setActive(true, "mapPan", true);
    await flushPromises();
    expect(tour.isRunning).toBe(false);
    expect(finished).toBe(1);
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(false);
  });

  test("an empty tour finishes at once", () => {
    const map = makeMap(ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12));
    const tour = new ImmersiveMapCameraTourController(map.camera);
    let finished = 0;
    tour.start([], { onFinished: () => (finished += 1) });
    expect(finished).toBe(1);
    expect(tour.isRunning).toBe(false);
  });
});

/** A jump that yields to the user's gestures, for an app that drives the camera every frame. */
describe("A jump that yields to gestures", () => {
  // At zoom 16 over Paris: the flat map, past the globe's upright pull.
  const start = ImmersiveMapCameraPosition.make(48.8566, 2.3522, 16, 0, 0.5);
  const next = ImmersiveMapCameraPosition.make(48.857, 2.353, 16.5, 0.3, 0.7);

  test("with no gesture under way it goes where it says", () => {
    const map = makeMap(start);
    map.camera.jump(next, { yieldsToGestures: true });
    const at = map.cameraRuntime.currentCameraPosition()!;
    expect(at.latitudeDegrees).toBeCloseTo(next.latitudeDegrees, 9);
    expect(at.zoom).toBeCloseTo(next.zoom, 9);
    expect(at.bearing).toBeCloseTo(next.bearing, 9);
    expect(at.pitch).toBeCloseTo(next.pitch, 9);
  });

  test("a plain jump cancels a turn's easing, a yielding one lets it run to the user's bearing", () => {
    for (const yieldsToGestures of [false, true]) {
      const map = makeMap(start);
      // A mouse turn: the bearing eases toward its target over the next frames.
      map.interactionRuntime.setActive(true, "mapTilt", true);
      map.cameraAnimationRuntime.setBearingTarget(0.8);
      map.run(0.05);
      map.interactionRuntime.setActive(false, "mapTilt", false);
      map.camera.jump(next, { yieldsToGestures });
      map.run(1.5);
      const bearing = map.cameraRuntime.currentCameraPosition()!.bearing;
      if (yieldsToGestures) expect(bearing).toBeCloseTo(0.8, 3);
      else expect(bearing).toBeCloseTo(next.bearing, 9);
    }
  });

  test("while a tilt drag runs it keeps the user's bearing and pitch, and moves the centre and zoom", () => {
    const map = makeMap(start);
    map.interactionRuntime.setActive(true, "mapTilt", true);
    const user = map.cameraRuntime.currentCameraPosition()!;
    map.camera.jump(next, { yieldsToGestures: true });
    const at = map.cameraRuntime.currentCameraPosition()!;
    expect(at.bearing).toBeCloseTo(user.bearing, 9);
    expect(at.pitch).toBeCloseTo(user.pitch, 9);
    expect(at.latitudeDegrees).toBeCloseTo(next.latitudeDegrees, 9);
    expect(at.zoom).toBeCloseTo(next.zoom, 9);
  });

  test("while a pan runs it keeps the centre, and while a pinch or the wheel runs, the zoom", () => {
    const map = makeMap(start);
    map.interactionRuntime.setActive(true, "mapPan", true);
    map.camera.jump(next, { yieldsToGestures: true });
    let at = map.cameraRuntime.currentCameraPosition()!;
    expect(at.latitudeDegrees).toBeCloseTo(start.latitudeDegrees, 9);
    expect(at.longitudeDegrees).toBeCloseTo(start.longitudeDegrees, 9);
    expect(at.bearing).toBeCloseTo(next.bearing, 9);
    map.interactionRuntime.setActive(false, "mapPan", false);
    for (const source of ["mapPinch", "scrollZoom"] as const) {
      map.camera.jump(start, { yieldsToGestures: true });
      map.interactionRuntime.setActive(true, source, true);
      map.camera.jump(next, { yieldsToGestures: true });
      at = map.cameraRuntime.currentCameraPosition()!;
      expect(at.zoom, source).toBeCloseTo(start.zoom, 9);
      expect(at.latitudeDegrees, source).toBeCloseTo(next.latitudeDegrees, 9);
      map.interactionRuntime.setActive(false, source, false);
    }
    // Once the gesture is over, the next jump puts everything where it says.
    map.camera.jump(next, { yieldsToGestures: true });
    at = map.cameraRuntime.currentCameraPosition()!;
    expect(at.zoom).toBeCloseTo(next.zoom, 9);
  });

  test("it still cancels the app's own flight", () => {
    const map = makeMap(start);
    let finished: boolean | null = null;
    map.camera.fly(ImmersiveMapCameraPosition.make(52.52, 13.405, 13), CameraFlightOptions.make(1), (value) => (finished = value));
    map.camera.jump(next, { yieldsToGestures: true });
    expect(finished).toBe(false);
  });
});
