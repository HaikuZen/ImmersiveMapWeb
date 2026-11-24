// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { defaultRenderLoopSettings } from "../../configuration/view-settings.ts";
import type { Vec2 } from "../../math/vec.ts";
import { ImmersiveMapCameraController } from "../camera/immersive-map-camera-controller.ts";
import { createImmersiveMapCameraRuntimes } from "../camera/immersive-map-camera-runtimes.ts";
import { ControlZones } from "../control-zone/control-zones.ts";
import { RenderLoopDriver } from "../render-loop-pacing.ts";
import { type GestureTimers, MapGestureController, wheelZoomDelta } from "./map-gesture-controller.ts";

const width = 400;
const height = 300;

/** A map on a fake surface, a fake clock and fake timers, with the events a browser would dispatch. */
function makeMap(
  cameraPosition: ImmersiveMapCameraPosition = ImmersiveMapCameraPosition.make(48.8566, 2.3522, 12),
  /** The settings the map runs by, and the taps a feature of the map claims. */
  extra: { readonly settings?: ImmersiveMapSettings; readonly claims?: ReadonlySet<"double" | "secondary"> } = {},
) {
  let time = 100;
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const fakeTimers: GestureTimers = {
    setTimeout: (callback) => {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const render = new RenderLoopDriver({
    configuration: defaultRenderLoopSettings,
    renderFrame: () => true,
    scheduler: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined },
    now: () => time,
  });
  const camera = new ImmersiveMapCameraController();
  const zones = new ControlZones(ImmersiveMapSettings.default.camera.controlZones);
  const runtimes = createImmersiveMapCameraRuntimes({
    settings: extra.settings ?? ImmersiveMapSettings.default,
    initialCameraPosition: cameraPosition,
    cameraController: camera,
    render,
    controls: zones,
    viewportSize: () => [width, height],
    now: () => time,
  });
  zones.attach(runtimes);
  const surface = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 10, top: 20, width, height }),
    style: { touchAction: "auto" },
  });
  const taps: Vec2[] = [];
  const claimedTaps: { kind: string; point: Vec2 }[] = [];
  const gestures = new MapGestureController({
    surface,
    host: runtimes,
    controlZones: zones,
    onTap: (point) => taps.push(point),
    isTapClaimed: (kind) => extra.claims?.has(kind) ?? false,
    onClaimedTap: (kind, point) => claimedTaps.push({ kind, point }),
    now: () => time,
    timers: fakeTimers,
  });

  const dispatch = (type: string, fields: Record<string, unknown>): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    surface.dispatchEvent(event);
    return event;
  };
  const pointer = (type: string, id: number, x: number, y: number, extra: Record<string, unknown> = {}): void => {
    dispatch(type, { pointerId: id, pointerType: "touch", clientX: x + 10, clientY: y + 20, button: 0, altKey: false, ...extra });
  };
  const advance = (seconds: number): void => {
    time += seconds;
  };
  const fireTimers = (): void => {
    const due = [...timers.values()];
    timers.clear();
    for (const callback of due) {
      callback();
    }
  };
  return { ...runtimes, camera, render, surface, gestures, zones, taps, claimedTaps, dispatch, pointer, advance, fireTimers };
}

describe("MapGestureController", () => {
  test("it owns the surface's touch-action and gives it back on detach", () => {
    const map = makeMap();
    expect(map.surface.style.touchAction).toBe("none");
    map.gestures.detach();
    expect(map.surface.style.touchAction).toBe("auto");
    // Detached, the surface's events reach nothing.
    const before = map.cameraRuntime.currentCameraState()!;
    map.pointer("pointerdown", 1, 200, 150);
    map.pointer("pointermove", 1, 260, 150);
    expect(map.cameraRuntime.currentCameraState()).toEqual(before);
  });

  test("a one-finger drag pans, reports the interaction, and ends it on release", () => {
    const map = makeMap();
    let began = 0;
    map.camera.onUserInteractionBegan = () => {
      began += 1;
    };
    const before = map.cameraRuntime.currentCameraState()!.centerWorldMercator;
    map.pointer("pointerdown", 1, 200, 150);
    map.pointer("pointermove", 1, 203, 150);
    expect(map.interactionRuntime.hasActiveUserInteraction, "inside the slop nothing moves").toBe(false);
    map.advance(0.016);
    map.pointer("pointermove", 1, 240, 150);
    expect(map.interactionRuntime.isActive("mapPan")).toBe(true);
    expect(began).toBe(1);
    const after = map.cameraRuntime.currentCameraState()!.centerWorldMercator;
    expect(after[0], "dragging right moves the map right, the center west").toBeLessThan(before[0]);
    expect(map.render.pacing.renderingReasonDescription).toContain("interaction");
    map.pointer("pointerup", 1, 240, 150);
    expect(map.interactionRuntime.hasActiveUserInteraction).toBe(false);
    expect(map.taps).toEqual([]);
  });

  test("a fast release on the globe starts the inertia, the flat map has none", () => {
    const globe = makeMap(ImmersiveMapCameraPosition.make(0, 0, 2));
    globe.pointer("pointerdown", 1, 100, 150);
    for (let step = 1; step <= 6; step++) {
      globe.advance(0.01);
      globe.pointer("pointermove", 1, 100 + step * 20, 150);
    }
    globe.pointer("pointerup", 1, 220, 150);
    expect(globe.cameraAnimationRuntime.isGlobeCameraPanInertiaActive).toBe(true);
    const before = globe.cameraRuntime.currentCameraState()!.centerWorldMercator[0];
    globe.advance(0.016);
    globe.cameraAnimationRuntime.advanceAnimationsIfNeeded(100.2);
    globe.cameraAnimationRuntime.advanceAnimationsIfNeeded(100.216);
    expect(globe.cameraRuntime.currentCameraState()!.centerWorldMercator[0]).not.toBe(before);

    const flat = makeMap();
    flat.pointer("pointerdown", 1, 100, 150);
    for (let step = 1; step <= 6; step++) {
      flat.advance(0.01);
      flat.pointer("pointermove", 1, 100 + step * 20, 150);
    }
    flat.pointer("pointerup", 1, 220, 150);
    expect(flat.cameraAnimationRuntime.isGlobeCameraPanInertiaActive).toBe(false);
  });

  test("a pinch zooms at the fingers' centre", () => {
    const map = makeMap();
    const zoom = map.cameraRuntime.currentCameraState()!.zoom;
    map.pointer("pointerdown", 1, 150, 150);
    map.pointer("pointerdown", 2, 250, 150);
    map.advance(0.016);
    map.pointer("pointermove", 1, 120, 150);
    map.advance(0.016);
    map.pointer("pointermove", 2, 280, 150);
    expect(map.interactionRuntime.isActive("mapPinch")).toBe(true);
    expect(map.cameraRuntime.currentCameraState()!.zoom).toBeGreaterThan(zoom);
    map.pointer("pointerup", 1, 120, 150);
    expect(map.interactionRuntime.isActive("mapPinch")).toBe(false);
  });

  test("a two-finger twist rotates by the rotation sensitivity", () => {
    const map = makeMap();
    map.pointer("pointerdown", 1, 150, 150);
    map.pointer("pointerdown", 2, 250, 150);
    // Turn the pair clockwise on screen by about 0.2 rad around its centre.
    const angle = 0.2;
    map.pointer("pointermove", 2, 200 + 50 * Math.cos(angle), 150 + 50 * Math.sin(angle));
    map.pointer("pointermove", 1, 200 - 50 * Math.cos(angle), 150 - 50 * Math.sin(angle));
    expect(map.interactionRuntime.isActive("mapRotation")).toBe(true);
    const sensitivity = ImmersiveMapSettings.default.camera.rotationGestureSensitivity;
    expect(map.cameraRuntime.currentCameraState()!.bearing).toBeCloseTo(angle * sensitivity, 3);
  });

  test("a side-by-side vertical two-finger drag tilts, a stacked one never does", () => {
    const map = makeMap();
    map.pointer("pointerdown", 1, 150, 100);
    map.pointer("pointerdown", 2, 250, 100);
    for (let step = 1; step <= 5; step++) {
      map.pointer("pointermove", 1, 150, 100 + step * 10);
      map.pointer("pointermove", 2, 250, 100 + step * 10);
    }
    expect(map.interactionRuntime.isActive("mapTilt")).toBe(true);
    map.cameraAnimationRuntime.advanceAnimationsIfNeeded(101);
    expect(map.cameraRuntime.currentCameraState()!.pitch, "dragging down tilts further").toBeGreaterThan(0);
    map.pointer("pointerup", 1, 150, 150);
    map.pointer("pointerup", 2, 250, 150);

    const stacked = makeMap();
    stacked.pointer("pointerdown", 1, 200, 50);
    stacked.pointer("pointerdown", 2, 210, 200);
    for (let step = 1; step <= 5; step++) {
      stacked.pointer("pointermove", 1, 200, 50 + step * 10);
      stacked.pointer("pointermove", 2, 210, 200 + step * 10);
    }
    expect(stacked.interactionRuntime.isActive("mapTilt")).toBe(false);
  });

  test("a slow mouse tilt counts the whole drag and eases into its end", () => {
    const map = makeMap();
    const mouse = { pointerType: "mouse", button: 2 };
    const sensitivity = map.cameraRuntime.currentSettings.camera.tiltGestureSensitivity;
    const maximumPitch = map.cameraRuntime.currentMaximumPitch();
    // Thirty moves of 2 points, one per frame: the follow trails each step.
    map.pointer("pointerdown", 7, 200, 100, mouse);
    let time = 101;
    for (let i = 1; i <= 30; i++) {
      map.pointer("pointermove", 7, 200, 100 + 2 * i, mouse);
      time += 1 / 60;
      map.advance(1 / 60);
      map.cameraAnimationRuntime.advanceAnimationsIfNeeded(time);
    }
    map.pointer("pointerup", 7, 200, 160, mouse);
    // After the pointer stops, the camera keeps easing to the drag's end.
    for (let i = 0; i < 120; i++) {
      time += 1 / 60;
      map.advance(1 / 60);
      map.cameraAnimationRuntime.advanceAnimationsIfNeeded(time);
    }
    const expected = Math.min((60 / height) * maximumPitch * sensitivity, maximumPitch);
    expect(map.cameraRuntime.currentCameraState()!.pitch).toBeCloseTo(expected, 3);
  });

  test("a tilt back from the ceiling moves when the pointer events land just before each frame", () => {
    // A browser delivers the pointer moves about a millisecond before the
    // frame they belong to. The camera stands at its steepest, the follow
    // still creeping to the ceiling, and the drag turns back up.
    const map = makeMap(ImmersiveMapCameraPosition.make(55.752, 37.6175, 13));
    const mouse = { pointerType: "mouse", button: 2 };
    let time = 100;
    const frame = (): void => {
      time += 1 / 60;
      map.advance(1 / 60);
      map.cameraAnimationRuntime.advanceAnimationsIfNeeded(time);
    };
    const moveBeforeFrame = (y: number): void => {
      // The event 1 ms before the frame's clock.
      map.advance(1 / 60 - 0.001);
      map.pointer("pointermove", 7, 200, y, mouse);
      map.advance(0.001 - 1 / 60);
      frame();
    };
    map.pointer("pointerdown", 7, 200, 20, mouse);
    for (let y = 30; y <= 280; y += 10) moveBeforeFrame(y);
    for (let i = 0; i < 12; i++) frame();
    const maximumPitch = map.cameraRuntime.currentMaximumPitch();
    expect(map.cameraRuntime.currentCameraState()!.pitch).toBeGreaterThan(maximumPitch - 0.01);
    // More of the same drag at the ceiling, then back up by 60 points.
    for (let y = 282; y <= 290; y += 2) moveBeforeFrame(y);
    for (let y = 288; y >= 230; y -= 2) moveBeforeFrame(y);
    for (let i = 0; i < 120; i++) frame();
    const sensitivity = map.cameraRuntime.currentSettings.camera.tiltGestureSensitivity;
    const expected = maximumPitch - (60 / height) * maximumPitch * sensitivity;
    expect(map.cameraRuntime.currentCameraState()!.pitch).toBeCloseTo(expected, 2);
  });

  test("a mouse turn eases over the uneven steps of the pointer and loses none of them", () => {
    const map = makeMap();
    const mouse = { pointerType: "mouse", button: 2 };
    map.pointer("pointerdown", 7, 50, 100, mouse);
    // A steady hand as a mouse reports it: the step per frame wanders.
    const steps = [10, 12, 9, 13, 10, 8, 12, 10, 11, 9, 13, 10];
    let x = 50;
    let time = 101;
    const speeds: number[] = [];
    let last = map.cameraRuntime.currentCameraState()!.bearing;
    for (const step of [...steps, ...steps, ...steps]) {
      x += step;
      map.pointer("pointermove", 7, x, 100, mouse);
      time += 1 / 60;
      map.cameraAnimationRuntime.advanceAnimationsIfNeeded(time);
      const bearing = map.cameraRuntime.currentCameraState()!.bearing;
      speeds.push(bearing - last);
      last = bearing;
    }
    // Once the follow has caught up with the drag's speed, the camera's step
    // per frame wanders far less than the pointer's (which spans 8 to 13).
    const settled = speeds.slice(18);
    const mean = settled.reduce((sum, v) => sum + v, 0) / settled.length;
    const worst = Math.max(...settled.map((v) => Math.abs(v - mean) / mean));
    expect(worst).toBeLessThan(0.12);
    map.pointer("pointerup", 7, x, 100, mouse);
    for (let frame = 0; frame < 120; frame++) {
      time += 1 / 60;
      map.cameraAnimationRuntime.advanceAnimationsIfNeeded(time);
    }
    expect(map.cameraRuntime.currentCameraState()!.bearing).toBeCloseTo(((x - 50) / width) * Math.PI, 3);
  });

  test("a right-button or Alt mouse drag tilts and rotates", () => {
    const map = makeMap();
    const mouse = { pointerType: "mouse", button: 2 };
    map.pointer("pointerdown", 7, 200, 100, mouse);
    map.pointer("pointermove", 7, 200, 160, mouse);
    map.pointer("pointermove", 7, 300, 160, mouse);
    expect(map.interactionRuntime.isActive("mapTilt")).toBe(true);
    // Both ease to their targets: the whole drag counts once the follows settle.
    for (let frame = 1; frame <= 120; frame++) {
      map.cameraAnimationRuntime.advanceAnimationsIfNeeded(101 + frame / 60);
    }
    const state = map.cameraRuntime.currentCameraState()!;
    expect(state.pitch).toBeGreaterThan(0);
    expect(state.bearing).toBeCloseTo((100 / width) * Math.PI, 3);
    map.pointer("pointerup", 7, 300, 160, mouse);
    expect(map.interactionRuntime.hasActiveUserInteraction).toBe(false);

    const alt = makeMap();
    alt.pointer("pointerdown", 8, 200, 100, { pointerType: "mouse", button: 0, altKey: true });
    alt.pointer("pointermove", 8, 260, 100, { pointerType: "mouse", button: 0, altKey: true });
    expect(alt.interactionRuntime.isActive("mapTilt")).toBe(true);
    expect(alt.interactionRuntime.isActive("mapPan")).toBe(false);
  });

  test("the wheel zooms at the cursor and the scroll interaction ends after a pause", () => {
    const map = makeMap();
    const zoom = map.cameraRuntime.currentCameraState()!.zoom;
    const event = map.dispatch("wheel", { deltaY: -150, deltaMode: 0, ctrlKey: false, clientX: 210, clientY: 170 });
    expect(event.defaultPrevented).toBe(true);
    expect(map.cameraRuntime.currentCameraState()!.zoom).toBeCloseTo(zoom + 1, 9);
    expect(map.interactionRuntime.isActive("scrollZoom")).toBe(true);
    map.fireTimers();
    expect(map.interactionRuntime.isActive("scrollZoom")).toBe(false);
  });

  test("a trackpad pinch (ctrl and wheel) zooms by its magnification", () => {
    const map = makeMap();
    const zoom = map.cameraRuntime.currentCameraState()!.zoom;
    map.dispatch("wheel", { deltaY: -10, deltaMode: 0, ctrlKey: true, clientX: 210, clientY: 170 });
    expect(map.interactionRuntime.isActive("mapPinch")).toBe(true);
    expect(map.cameraRuntime.currentCameraState()!.zoom).toBeGreaterThan(zoom);
    map.fireTimers();
    expect(map.interactionRuntime.isActive("mapPinch")).toBe(false);
  });

  test("wheel units convert to zoom levels", () => {
    expect(wheelZoomDelta({ deltaY: -150, deltaMode: 0 })).toBeCloseTo(1, 12);
    expect(wheelZoomDelta({ deltaY: 3, deltaMode: 1 })).toBeCloseTo(-1 / 3, 12);
    expect(wheelZoomDelta({ deltaY: -1, deltaMode: 2 })).toBeCloseTo(1, 12);
  });

  test("a tap reports once no second one follows, a double tap flies one level in", () => {
    const map = makeMap();
    map.pointer("pointerdown", 1, 100, 100);
    map.pointer("pointerup", 1, 100, 100);
    expect(map.taps, "the single tap waits for the double tap to fail").toEqual([]);
    map.fireTimers();
    expect(map.taps).toEqual([[100, 100]]);

    const zoom = map.cameraRuntime.currentCameraState()!.zoom;
    map.advance(1);
    map.pointer("pointerdown", 2, 200, 100);
    map.pointer("pointerup", 2, 200, 100);
    map.advance(0.15);
    map.pointer("pointerdown", 3, 202, 101);
    map.pointer("pointerup", 3, 202, 101);
    map.fireTimers();
    expect(map.taps.length).toBe(1);
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(true);
    map.cameraAnimationRuntime.advanceAnimationsIfNeeded(102);
    expect(map.cameraRuntime.currentCameraState()!.zoom).toBeCloseTo(zoom + 1, 6);
  });

  test("with the double tap zoom off a tap reports at once and a second one counts", () => {
    const map = makeMap(undefined, { settings: ImmersiveMapSettings.default.doubleTapZoom(false) });
    const zoom = map.cameraRuntime.currentCameraState()!.zoom;
    map.pointer("pointerdown", 1, 100, 100);
    map.pointer("pointerup", 1, 100, 100);
    expect(map.taps).toEqual([[100, 100]]);
    map.advance(0.1);
    map.pointer("pointerdown", 1, 101, 100);
    map.pointer("pointerup", 1, 101, 100);
    expect(map.taps).toEqual([
      [100, 100],
      [101, 100],
    ]);
    map.fireTimers();
    expect(map.cameraRuntime.currentCameraState()!.zoom).toBe(zoom);
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(false);
  });

  test("a claimed double tap goes to its feature and does not zoom", () => {
    const map = makeMap(undefined, { claims: new Set(["double"]) });
    map.pointer("pointerdown", 1, 100, 100);
    map.pointer("pointerup", 1, 100, 100);
    map.advance(0.1);
    map.pointer("pointerdown", 1, 102, 100);
    map.pointer("pointerup", 1, 102, 100);
    expect(map.claimedTaps).toEqual([{ kind: "double", point: [102, 100] }]);
    expect(map.taps).toEqual([]);
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(false);
    // A single tap stays a tap, once no second one follows.
    map.advance(1);
    map.pointer("pointerdown", 1, 50, 50);
    map.pointer("pointerup", 1, 50, 50);
    map.fireTimers();
    expect(map.taps).toEqual([[50, 50]]);
  });

  test("a click of the right button is a claimed secondary tap, a drag of it still tilts", () => {
    const map = makeMap(undefined, { claims: new Set(["secondary"]) });
    const mouse = { pointerType: "mouse", button: 2 };
    map.pointer("pointerdown", 1, 100, 100, mouse);
    map.pointer("pointerup", 1, 100, 100, mouse);
    expect(map.claimedTaps).toEqual([{ kind: "secondary", point: [100, 100] }]);
    map.pointer("pointerdown", 1, 100, 100, mouse);
    map.pointer("pointermove", 1, 100, 160, mouse);
    expect(map.interactionRuntime.isActive("mapTilt"), "the drag is the tilt's").toBe(true);
    map.pointer("pointerup", 1, 100, 160, mouse);
    expect(map.claimedTaps).toHaveLength(1);
    // Unclaimed, the click is nothing.
    const plain = makeMap();
    plain.pointer("pointerdown", 1, 100, 100, mouse);
    plain.pointer("pointerup", 1, 100, 100, mouse);
    expect(plain.claimedTaps).toEqual([]);
  });

  test("a touch held on its place is a claimed secondary tap, a touch that moves is not", () => {
    const map = makeMap(undefined, { claims: new Set(["secondary"]) });
    map.pointer("pointerdown", 1, 100, 100);
    map.advance(0.5);
    map.fireTimers();
    expect(map.claimedTaps).toEqual([{ kind: "secondary", point: [100, 100] }]);
    map.pointer("pointerup", 1, 100, 100);
    map.fireTimers();
    expect(map.taps).toEqual([]);
    map.pointer("pointerdown", 1, 100, 100);
    map.pointer("pointermove", 1, 100, 140);
    map.advance(0.5);
    map.fireTimers();
    map.pointer("pointerup", 1, 100, 140);
    expect(map.claimedTaps).toHaveLength(1);
  });

  test("a mouse press within the tap tolerance is a click, past it a drag", () => {
    const map = makeMap(undefined, { settings: ImmersiveMapSettings.default.doubleTapZoom(false).tapMovementTolerance(6) });
    const mouse = { pointerType: "mouse" };
    const centre = map.cameraRuntime.currentCameraState()!.centerWorldMercator;
    map.pointer("pointerdown", 1, 100, 100, mouse);
    map.pointer("pointermove", 1, 105, 100, mouse);
    map.pointer("pointerup", 1, 105, 100, mouse);
    expect(map.taps).toEqual([[105, 100]]);
    expect(map.cameraRuntime.currentCameraState()!.centerWorldMercator).toEqual(centre);
    map.pointer("pointerdown", 1, 100, 100, mouse);
    map.pointer("pointermove", 1, 107, 100, mouse);
    map.pointer("pointermove", 1, 120, 100, mouse);
    map.pointer("pointerup", 1, 120, 100, mouse);
    expect(map.taps).toHaveLength(1);
    expect(map.cameraRuntime.currentCameraState()!.centerWorldMercator).not.toEqual(centre);
  });

  test("a drag in the zoom zone zooms instead of panning, for touch only", () => {
    const map = makeMap();
    const before = map.cameraRuntime.currentCameraState()!;
    // The zoom zone is the bottom trailing 132 by 240.
    map.pointer("pointerdown", 1, 350, 250);
    map.pointer("pointermove", 1, 350, 240);
    map.advance(0.016);
    map.pointer("pointermove", 1, 350, 200);
    expect(map.interactionRuntime.isActive("zoomControl")).toBe(true);
    const after = map.cameraRuntime.currentCameraState()!;
    expect(after.zoom, "dragging up zooms in").toBeGreaterThan(before.zoom);
    expect(after.centerWorldMercator).toEqual(before.centerWorldMercator);
    map.pointer("pointerup", 1, 350, 200);
    expect(map.interactionRuntime.isActive("zoomControl")).toBe(false);

    const mouse = makeMap();
    mouse.pointer("pointerdown", 2, 350, 250, { pointerType: "mouse" });
    mouse.pointer("pointermove", 2, 350, 200, { pointerType: "mouse" });
    expect(mouse.interactionRuntime.isActive("mapPan"), "a mouse pans the whole map").toBe(true);
  });

  test("a drag in the pitch zone tilts, and a disabled zone pans", () => {
    const map = makeMap();
    // The pitch zone is the bottom leading 88 by 188. Its value runs from
    // the full tilt at the top to level at the bottom, so dragging down
    // tilts further.
    map.pointer("pointerdown", 1, 40, 150);
    map.pointer("pointermove", 1, 40, 160);
    map.pointer("pointermove", 1, 40, 250);
    expect(map.interactionRuntime.isActive("pitchControl")).toBe(true);
    map.cameraAnimationRuntime.advanceAnimationsIfNeeded(101);
    expect(map.cameraRuntime.currentCameraState()!.pitch).toBeGreaterThan(0);
    map.pointer("pointerup", 1, 40, 250);

    const off = makeMap();
    off.zones.applyControlZones({ isPitchZoneEnabled: false, isZoomZoneEnabled: true }, false);
    off.pointer("pointerdown", 1, 40, 280);
    off.pointer("pointermove", 1, 40, 200);
    expect(off.interactionRuntime.isActive("mapPan")).toBe(true);
  });

  test("a user gesture stops a flight", () => {
    const map = makeMap();
    let finished: boolean | null = null;
    map.camera.fly(ImmersiveMapCameraPosition.make(10, 10, 5), undefined, (value) => (finished = value));
    expect(map.cameraAnimationRuntime.isCameraFlightActive).toBe(true);
    map.pointer("pointerdown", 1, 100, 100);
    map.pointer("pointermove", 1, 150, 100);
    expect(finished).toBe(false);
  });
});
