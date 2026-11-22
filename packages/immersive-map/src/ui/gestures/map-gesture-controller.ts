// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraFlightOptions } from "../../camera/immersive-map-camera-position.ts";
import { TwoFingerTiltGestureMath } from "../../math/two-finger-tilt-gesture-math.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { ImmersiveMapCameraRuntimes } from "../camera/immersive-map-camera-runtimes.ts";
import type { InteractionSource } from "../camera/immersive-map-interaction-runtime.ts";
import type { ControlZoneDrag, ControlZones } from "../control-zone/control-zones.ts";
import { ScrollPhase, ScrollZoomInteractionPhaseResolver } from "./scroll-zoom-interaction-phase-resolver.ts";

/** What the gestures drive: the camera, its animations and the interaction state. */
export type MapGestureHost = Pick<ImmersiveMapCameraRuntimes, "cameraRuntime" | "cameraAnimationRuntime" | "interactionRuntime">;

/**
 * The element the controller listens on, usually the map's canvas. Any
 * `HTMLElement` is one. The structural type lets tests drive the controller
 * with a plain `EventTarget`.
 */
export interface GestureSurface {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  getBoundingClientRect(): { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  readonly style: { touchAction: string };
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

/** `setTimeout` and `clearTimeout`, injectable for tests. */
export interface GestureTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MapGestureControllerOptions {
  readonly surface: GestureSurface;
  readonly host: MapGestureHost;
  /** The one-thumb zones, hit only by touch pointers. */
  readonly controlZones?: ControlZones;
  /**
   * A single tap or click on the map, in CSS pixels from the surface's
   * top-left corner, once it is clear no double tap follows: selection, or
   * the background tap.
   */
  readonly onTap?: (point: Vec2, pointerType: string) => void;
  /** Seconds on the render loop's clock, `performance.now() / 1000` by default. */
  readonly now?: () => number;
  readonly timers?: GestureTimers;
}

/** The slop a pointer moves before a drag is recognized, in CSS pixels. */
const touchSlop = 8;
const mouseSlop = 3;
/** How long the controller waits for a second tap, in seconds, and how far it may land from the first, in CSS pixels. */
const doubleTapInterval = 0.3;
const doubleTapDistance = 40;
/** A press held longer than this is no tap. */
const tapMaximumDuration = 0.5;
/** The window the release velocity is measured over, in seconds. */
const velocityWindow = 0.1;
/** How far two fingers must spread or turn before the pinch or the rotation is recognized. */
const pinchSlop = 6;
const rotationSlop = 0.06;
/** A pause in the wheel stream this long ends the scroll interaction, in seconds. */
const wheelIdleSeconds = 0.15;
/** Wheel units: a trackpad's pixels per zoom level, a wheel notch's lines, a page. */
const wheelPixelsPerZoomLevel = 150;
const wheelLinesPerZoomLevel = 9;
/** A pinch's wheel `deltaY` per unit of magnification (Chrome and Firefox report a trackpad pinch as wheel events with `ctrlKey`). */
const pinchWheelDeltaPerMagnification = 100;
/** The double tap's anchored zoom: one level in, over this many seconds. */
const doubleTapZoomDelta = 1.0;
const doubleTapFlightDuration = 0.35;

type MapPointerRole = "map" | "zone";

interface TrackedPointer {
  readonly id: number;
  readonly type: string;
  readonly role: MapPointerRole;
  readonly zone: ControlZoneDrag | null;
  readonly button: number;
  readonly altKey: boolean;
  readonly startTime: number;
  start: Vec2;
  position: Vec2;
  last: Vec2;
  recognized: boolean;
  /** Recent (time, x, y) samples, for the release velocity. */
  samples: [number, number, number][];
}

/**
 * Where the two-finger drag stands between competing readings: it starts
 * undecided, commits to tilting once the movement is clearly vertical, and
 * once rejected stays inert until the fingers lift, leaving the drag to the
 * pinch and rotation running alongside it.
 */
type TiltPhase = "undecided" | "tilting" | "rejected";

interface TwoFingerState {
  readonly first: number;
  readonly second: number;
  readonly startDistance: number;
  lastDistance: number;
  lastAngle: number;
  accumulatedRotation: number;
  lastCentroid: Vec2;
  tiltTranslation: Vec2;
  tiltPhase: TiltPhase;
  pinchActive: boolean;
  rotationActive: boolean;
  lastTime: number;
}

type SingleMode = "none" | "pan" | "tilt";

/**
 * The map's gestures on Pointer Events, `wheel` and Safari's `gesture*`
 * events, translated into camera, selection and render-loop commands. It is
 * the browser's one controller for what the Swift engine splits into the
 * touch controller (`MapGestureController` on UIKit), the mouse and trackpad
 * one (`MapGestureControllerMac`) and the scroll zoom (`ScrollZoomGesture`),
 * telling touch from mouse by `pointerType`:
 *
 * - one pointer drag: pan, with the globe's inertia on release;
 * - mouse right-button drag, or Alt (Option) with the left button: vertical
 *   tilts (down tilts further, by `tiltGestureSensitivity`), horizontal
 *   rotates by half a turn across the width;
 * - two touches: pinch to zoom at their centre, twist to rotate
 *   (`rotationGestureSensitivity`), and a side-by-side vertical drag to tilt
 *   (`TwoFingerTiltGestureMath`), all three at once;
 * - wheel: zoom at the cursor, a trackpad pinch (`ctrlKey`) or Safari's
 *   gesture events scaling and rotating;
 * - tap or click: `onTap`, once no second one follows. A double tap or
 *   double click flies one level in toward the point.
 * - touch drags starting in an enabled control zone drive the zone.
 *
 * Every gesture cancels the camera animations when it begins and reports
 * the interaction (`ImmersiveMapInteractionRuntime`), which keeps the render
 * loop at the interaction rate and notifies the camera controller's
 * `onUserInteractionBegan` (tours and follows stop on it). Frames are
 * requested through the camera runtime.
 *
 * The controller sets `touch-action: none` on its surface and takes it back,
 * with every listener, on `detach`.
 */
export class MapGestureController {
  private readonly surface: GestureSurface;
  private readonly host: MapGestureHost;
  private readonly controlZones: ControlZones | null;
  private readonly onTap: ((point: Vec2, pointerType: string) => void) | null;
  private readonly now: () => number;
  private readonly timers: GestureTimers;
  private readonly abort = new AbortController();
  private readonly previousTouchAction: string;
  private readonly pointers = new Map<number, TrackedPointer>();
  private readonly activeSources = new Set<InteractionSource>();
  private rect: { left: number; top: number; width: number; height: number } = { left: 0, top: 0, width: 0, height: 0 };
  private singleMode: SingleMode = "none";
  private singlePointer: number | null = null;
  private twoFinger: TwoFingerState | null = null;
  private pendingTap: { point: Vec2; time: number; type: string; handle: unknown } | null = null;
  private wheelIdleHandle: unknown = null;
  private pinchWheelIdleHandle: unknown = null;
  private safariGesture: { lastScale: number; lastRotation: number } | null = null;
  private isDetached = false;

  constructor(options: MapGestureControllerOptions) {
    this.surface = options.surface;
    this.host = options.host;
    this.controlZones = options.controlZones ?? null;
    this.onTap = options.onTap ?? null;
    this.now = options.now ?? ((): number => performance.now() / 1000);
    this.timers = options.timers ?? {
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    };
    this.previousTouchAction = this.surface.style.touchAction;
    this.surface.style.touchAction = "none";

    const signal = this.abort.signal;
    const listen = (type: string, listener: (event: Event) => void, passive: boolean): void => {
      this.surface.addEventListener(type, listener, { signal, passive });
    };
    listen("pointerdown", (event) => this.handlePointerDown(event as PointerEvent), true);
    listen("pointermove", (event) => this.handlePointerMove(event as PointerEvent), true);
    listen("pointerup", (event) => this.handlePointerUp(event as PointerEvent, false), true);
    listen("pointercancel", (event) => this.handlePointerUp(event as PointerEvent, true), true);
    listen("wheel", (event) => this.handleWheel(event as WheelEvent), false);
    listen("contextmenu", (event) => event.preventDefault(), false);
    listen("gesturestart", (event) => this.handleSafariGesture(event, "start"), false);
    listen("gesturechange", (event) => this.handleSafariGesture(event, "change"), false);
    listen("gestureend", (event) => this.handleSafariGesture(event, "end"), false);
  }

  /** Removes every listener, ends the interactions it started and restores the surface's `touch-action`. */
  detach(): void {
    if (this.isDetached) {
      return;
    }
    this.isDetached = true;
    this.abort.abort();
    this.surface.style.touchAction = this.previousTouchAction;
    this.clearTimer(this.wheelIdleHandle);
    this.clearTimer(this.pinchWheelIdleHandle);
    if (this.pendingTap !== null) {
      this.clearTimer(this.pendingTap.handle);
      this.pendingTap = null;
    }
    for (const pointer of this.pointers.values()) {
      if (pointer.zone !== null && pointer.recognized) {
        pointer.zone.ended();
      }
    }
    this.pointers.clear();
    if (this.singleMode === "pan") {
      this.host.cameraRuntime.endPan();
    }
    this.singleMode = "none";
    this.twoFinger = null;
    for (const source of [...this.activeSources]) {
      this.setInteractionActive(false, source);
    }
  }

  /** Marks the map pan active or inactive as a drag would, for tests of what yields to the user. */
  setPanInteractionActiveForTesting(isActive: boolean): void {
    this.setInteractionActive(isActive, "mapPan");
  }

  // Pointers

  private handlePointerDown(event: PointerEvent): void {
    if (this.host.cameraRuntime.currentCameraState() === null) {
      return;
    }
    this.rect = this.surface.getBoundingClientRect();
    const point = this.pointOf(event);
    const time = this.now();
    const isMouse = event.pointerType === "mouse";
    if (isMouse && event.button !== 0 && event.button !== 2) {
      return;
    }
    this.controlZones?.layout(this.rect.width, this.rect.height);
    const mapPointers = this.mapPointerIds();
    const zone = event.pointerType === "touch" && mapPointers.length === 0 ? (this.controlZones?.hitTest(point) ?? null) : null;
    const pointer: TrackedPointer = {
      id: event.pointerId,
      type: event.pointerType,
      role: zone === null ? "map" : "zone",
      zone,
      button: event.button,
      altKey: event.altKey,
      startTime: time,
      start: point,
      position: point,
      last: point,
      recognized: false,
      samples: [[time, point[0], point[1]]],
    };
    this.pointers.set(event.pointerId, pointer);
    try {
      this.surface.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the move events still arrive over the surface.
    }
    if (pointer.role === "zone") {
      return;
    }

    const ids = this.mapPointerIds();
    if (isMouse) {
      this.singlePointer = pointer.id;
      this.singleMode = "none";
      return;
    }
    if (ids.length === 1) {
      this.singlePointer = pointer.id;
      this.singleMode = "none";
    } else if (ids.length === 2 && this.twoFinger === null) {
      this.endSinglePointerGesture(true);
      this.beginTwoFinger(ids[0]!, ids[1]!, time);
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    const pointer = this.pointers.get(event.pointerId);
    if (pointer === undefined) {
      return;
    }
    const point = this.pointOf(event);
    const time = this.now();
    pointer.position = point;
    pointer.samples.push([time, point[0], point[1]]);
    while (pointer.samples.length > 2 && time - pointer.samples[0]![0] > velocityWindow) {
      pointer.samples.shift();
    }

    if (pointer.role === "zone") {
      this.moveZonePointer(pointer);
      return;
    }
    if (this.twoFinger !== null) {
      if (pointer.id === this.twoFinger.first || pointer.id === this.twoFinger.second) {
        this.moveTwoFinger(time);
      }
      return;
    }
    if (pointer.id === this.singlePointer) {
      this.moveSinglePointer(pointer);
    }
  }

  private handlePointerUp(event: PointerEvent, cancelled: boolean): void {
    const pointer = this.pointers.get(event.pointerId);
    if (pointer === undefined) {
      return;
    }
    this.pointers.delete(event.pointerId);
    try {
      this.surface.releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released.
    }
    const time = this.now();

    if (pointer.role === "zone") {
      if (pointer.recognized) {
        pointer.zone?.ended();
      }
      return;
    }

    const twoFinger = this.twoFinger;
    if (twoFinger !== null && (pointer.id === twoFinger.first || pointer.id === twoFinger.second)) {
      this.endTwoFinger();
      // The finger left down pans again once it moves past the slop, from
      // where it is now.
      const remainingId = pointer.id === twoFinger.first ? twoFinger.second : twoFinger.first;
      const remaining = this.pointers.get(remainingId);
      if (remaining !== undefined) {
        remaining.start = remaining.position;
        remaining.last = remaining.position;
        remaining.recognized = false;
        remaining.samples = [[time, remaining.position[0], remaining.position[1]]];
        this.singlePointer = remaining.id;
        this.singleMode = "none";
      }
      return;
    }

    if (pointer.id !== this.singlePointer) {
      return;
    }
    this.singlePointer = null;
    if (!pointer.recognized) {
      this.singleMode = "none";
      const isPrimary = pointer.type !== "mouse" || pointer.button === 0;
      if (!cancelled && isPrimary && time - pointer.startTime <= tapMaximumDuration) {
        this.handleTap(pointer.position, pointer.type, time);
      }
      return;
    }
    if (this.singleMode === "pan") {
      this.singleMode = "none";
      this.setInteractionActive(false, "mapPan");
      this.host.cameraRuntime.endPan();
      if (cancelled) {
        this.host.cameraAnimationRuntime.cancelGlobeCameraPanInertia();
      } else {
        this.host.cameraAnimationRuntime.startGlobeCameraPanInertiaIfNeeded(releaseVelocity(pointer, time), time);
      }
      return;
    }
    if (this.singleMode === "tilt") {
      this.singleMode = "none";
      this.setInteractionActive(false, "mapTilt");
    }
  }

  private moveSinglePointer(pointer: TrackedPointer): void {
    if (!pointer.recognized) {
      const slop = pointer.type === "mouse" ? mouseSlop : touchSlop;
      if (Math.hypot(pointer.position[0] - pointer.start[0], pointer.position[1] - pointer.start[1]) < slop) {
        return;
      }
      pointer.recognized = true;
      const tilts = pointer.type === "mouse" && (pointer.button === 2 || pointer.altKey);
      this.singleMode = tilts ? "tilt" : "pan";
      this.setInteractionActive(true, tilts ? "mapTilt" : "mapPan");
    }
    const deltaX = pointer.position[0] - pointer.last[0];
    const deltaY = pointer.position[1] - pointer.last[1];
    pointer.last = pointer.position;
    if (this.singleMode === "pan") {
      const scale = this.host.cameraRuntime.currentSettings.camera.gesturePanTranslationScale;
      this.host.cameraRuntime.panCamera(deltaX * scale, deltaY * scale);
    } else if (this.singleMode === "tilt") {
      this.applyMouseTilt(deltaX, deltaY);
    }
  }

  /**
   * Vertical dragging changes pitch (down tilts further, inverted by a
   * negative `tiltGestureSensitivity`), horizontal dragging rotates the
   * camera by half a turn across the map's width.
   */
  private applyMouseTilt(deltaX: number, deltaY: number): void {
    const { width, height } = this.rect;
    if (!(width > 0) || !(height > 0)) {
      return;
    }
    const cameraRuntime = this.host.cameraRuntime;
    const currentPitch = this.host.cameraAnimationRuntime.pitchGestureBase();
    if (deltaY !== 0 && currentPitch !== null) {
      const sensitivity = cameraRuntime.currentSettings.camera.tiltGestureSensitivity;
      const pitchDelta = TwoFingerTiltGestureMath.pitchDelta(deltaY, height, cameraRuntime.currentMaximumPitch(), sensitivity);
      this.host.cameraAnimationRuntime.setPitchTarget(currentPitch + pitchDelta);
    }
    if (deltaX !== 0) {
      this.host.cameraAnimationRuntime.rotateByGesture((deltaX / width) * Math.PI);
    }
  }

  /** Ends the one-pointer drag when a second finger turns it into a two-finger gesture, as a cancelled pan. */
  private endSinglePointerGesture(cancelled: boolean): void {
    const pointer = this.singlePointer === null ? undefined : this.pointers.get(this.singlePointer);
    if (this.singleMode === "pan") {
      this.setInteractionActive(false, "mapPan");
      this.host.cameraRuntime.endPan();
      if (cancelled) {
        this.host.cameraAnimationRuntime.cancelGlobeCameraPanInertia();
      }
    } else if (this.singleMode === "tilt") {
      this.setInteractionActive(false, "mapTilt");
    }
    if (pointer !== undefined) {
      pointer.recognized = true;
    }
    this.singleMode = "none";
    this.singlePointer = null;
  }

  // Two fingers

  private beginTwoFinger(first: number, second: number, time: number): void {
    const a = this.pointers.get(first)!;
    const b = this.pointers.get(second)!;
    const distance = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1]);
    this.twoFinger = {
      first,
      second,
      startDistance: distance,
      lastDistance: distance,
      lastAngle: Math.atan2(b.position[1] - a.position[1], b.position[0] - a.position[0]),
      accumulatedRotation: 0,
      lastCentroid: centroid(a.position, b.position),
      tiltTranslation: [0, 0],
      tiltPhase: TwoFingerTiltGestureMath.touchLayoutAllowsTilt(a.position, b.position) ? "undecided" : "rejected",
      pinchActive: false,
      rotationActive: false,
      lastTime: time,
    };
  }

  private moveTwoFinger(time: number): void {
    const state = this.twoFinger!;
    const a = this.pointers.get(state.first);
    const b = this.pointers.get(state.second);
    if (a === undefined || b === undefined) {
      return;
    }
    const cameraRuntime = this.host.cameraRuntime;
    const settings = cameraRuntime.currentSettings.camera;
    const distance = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1]);
    const angle = Math.atan2(b.position[1] - a.position[1], b.position[0] - a.position[0]);
    const center = centroid(a.position, b.position);
    const deltaTime = time - state.lastTime;
    state.lastTime = time;

    // Pinch: the spread's ratio since the last event, at the fingers' centre.
    if (!state.pinchActive && Math.abs(distance - state.startDistance) >= pinchSlop) {
      state.pinchActive = true;
      this.setInteractionActive(true, "mapPinch");
    }
    if (state.pinchActive && state.lastDistance > 0 && distance > 0) {
      const scale = distance / state.lastDistance;
      const velocity = deltaTime > 0 ? (scale - 1) / deltaTime : 0;
      cameraRuntime.zoomCameraByScale(scale, velocity, center);
    }
    state.lastDistance = distance;

    // Rotation: clockwise on screen is positive, as UIKit's rotation is.
    const angleDelta = wrapAngle(angle - state.lastAngle);
    state.lastAngle = angle;
    state.accumulatedRotation += angleDelta;
    if (!state.rotationActive && Math.abs(state.accumulatedRotation) >= rotationSlop) {
      state.rotationActive = true;
      this.setInteractionActive(true, "mapRotation");
      cameraRuntime.rotateCameraYaw(state.accumulatedRotation * settings.rotationGestureSensitivity);
    } else if (state.rotationActive) {
      cameraRuntime.rotateCameraYaw(angleDelta * settings.rotationGestureSensitivity);
    }

    // Tilt: the fingers' common movement, once it reveals itself as vertical.
    const translation: Vec2 = [center[0] - state.lastCentroid[0], center[1] - state.lastCentroid[1]];
    state.lastCentroid = center;
    state.tiltTranslation = [state.tiltTranslation[0] + translation[0], state.tiltTranslation[1] + translation[1]];
    switch (state.tiltPhase) {
      case "undecided":
        // Translation keeps accumulating until the drag reveals its
        // direction. Only then does the tilt engage, applying the whole
        // accumulated movement so nothing is lost to the wait.
        switch (TwoFingerTiltGestureMath.intent(state.tiltTranslation)) {
          case "undecided":
            break;
          case "tilt":
            state.tiltPhase = "tilting";
            this.setInteractionActive(true, "mapTilt");
            this.applyTwoFingerTilt(state);
            break;
          case "other":
            state.tiltPhase = "rejected";
            break;
        }
        break;
      case "tilting":
        this.applyTwoFingerTilt(state);
        break;
      case "rejected":
        break;
    }
  }

  private applyTwoFingerTilt(state: TwoFingerState): void {
    const translationY = state.tiltTranslation[1];
    state.tiltTranslation = [0, 0];
    const cameraRuntime = this.host.cameraRuntime;
    const currentPitch = this.host.cameraAnimationRuntime.pitchGestureBase();
    if (currentPitch === null) {
      return;
    }
    const sensitivity = cameraRuntime.currentSettings.camera.tiltGestureSensitivity;
    const pitchDelta = TwoFingerTiltGestureMath.pitchDelta(translationY, this.rect.height, cameraRuntime.currentMaximumPitch(), sensitivity);
    this.host.cameraAnimationRuntime.setPitchTarget(currentPitch + pitchDelta);
  }

  private endTwoFinger(): void {
    const state = this.twoFinger;
    this.twoFinger = null;
    if (state === null) {
      return;
    }
    if (state.pinchActive) {
      this.setInteractionActive(false, "mapPinch");
    }
    if (state.rotationActive) {
      this.setInteractionActive(false, "mapRotation");
    }
    if (state.tiltPhase === "tilting") {
      this.setInteractionActive(false, "mapTilt");
    }
  }

  // Control zones

  private moveZonePointer(pointer: TrackedPointer): void {
    const zone = pointer.zone;
    if (zone === null) {
      return;
    }
    if (!pointer.recognized) {
      if (Math.hypot(pointer.position[0] - pointer.start[0], pointer.position[1] - pointer.start[1]) < touchSlop) {
        return;
      }
      pointer.recognized = true;
      pointer.last = pointer.position;
      zone.began();
      return;
    }
    const translationY = pointer.position[1] - pointer.last[1];
    pointer.last = pointer.position;
    zone.changed(translationY, releaseVelocity(pointer, this.now())[1]);
  }

  // Taps

  /**
   * A single tap waits for the double tap to fail: it reports only once no
   * second tap follows within `doubleTapInterval`. A double tap zooms one
   * level in toward the point, the world point under the finger staying put
   * (see `zoomAnchorFactor`).
   */
  private handleTap(point: Vec2, pointerType: string, time: number): void {
    const pending = this.pendingTap;
    if (
      pending !== null &&
      time - pending.time <= doubleTapInterval &&
      Math.hypot(point[0] - pending.point[0], point[1] - pending.point[1]) <= doubleTapDistance
    ) {
      this.clearTimer(pending.handle);
      this.pendingTap = null;
      this.handleDoubleTap(point);
      return;
    }
    if (pending !== null) {
      this.clearTimer(pending.handle);
      this.onTap?.(pending.point, pending.type);
    }
    const handle = this.timers.setTimeout(() => {
      const tap = this.pendingTap;
      this.pendingTap = null;
      if (tap !== null) {
        this.onTap?.(tap.point, tap.type);
      }
    }, doubleTapInterval * 1000);
    this.pendingTap = { point, time, type: pointerType, handle };
  }

  private handleDoubleTap(point: Vec2): void {
    const cameraRuntime = this.host.cameraRuntime;
    if (cameraRuntime.currentCameraState() === null) {
      return;
    }
    const target = cameraRuntime.anchoredZoomTargetPosition(doubleTapZoomDelta, point);
    if (target === null) {
      return;
    }
    cameraRuntime.notifyUserInteractionBegan();
    this.host.cameraAnimationRuntime.startCameraFlight(target, CameraFlightOptions.make(doubleTapFlightDuration), null, this.now());
  }

  // Wheel

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const cameraRuntime = this.host.cameraRuntime;
    if (cameraRuntime.currentCameraState() === null) {
      return;
    }
    this.rect = this.surface.getBoundingClientRect();
    const anchor = this.pointOf(event);

    if (event.ctrlKey) {
      // A trackpad pinch, as Chrome and Firefox report one: the AppKit
      // magnification gesture's counterpart. Safari's own gesture events
      // win while they run.
      if (this.safariGesture !== null) {
        return;
      }
      if (!this.activeSources.has("mapPinch")) {
        this.setInteractionActive(true, "mapPinch");
      }
      this.clearTimer(this.pinchWheelIdleHandle);
      this.pinchWheelIdleHandle = this.timers.setTimeout(() => {
        this.pinchWheelIdleHandle = null;
        this.setInteractionActive(false, "mapPinch");
      }, wheelIdleSeconds * 1000);
      const scale = 1 - wheelPixels(event) / pinchWheelDeltaPerMagnification;
      if (scale > 0) {
        cameraRuntime.zoomCameraByScale(scale, 0, anchor);
      }
      return;
    }

    // The wheel has no phases: the first event of a burst begins the scroll
    // interaction and a pause ends it, so the zoom's tail runs at the
    // interaction rate like the rest of it.
    const phase = this.activeSources.has("scrollZoom") ? ScrollPhase.changed : ScrollPhase.began;
    if (ScrollZoomInteractionPhaseResolver.transition(phase, ScrollPhase.none) === "begin") {
      this.setInteractionActive(true, "scrollZoom");
    }
    this.clearTimer(this.wheelIdleHandle);
    this.wheelIdleHandle = this.timers.setTimeout(() => {
      this.wheelIdleHandle = null;
      if (ScrollZoomInteractionPhaseResolver.transition(ScrollPhase.ended, ScrollPhase.none) === "end") {
        this.setInteractionActive(false, "scrollZoom");
      }
    }, wheelIdleSeconds * 1000);

    // Wheel or scroll up zooms the map in.
    const delta = wheelZoomDelta(event);
    if (delta !== 0) {
      cameraRuntime.zoomCameraByDelta(delta, anchor);
    }
  }

  // Safari

  /**
   * Safari's trackpad pinch and rotation (`gesturestart`, `gesturechange`,
   * `gestureend`, with the cumulative `scale` and clockwise `rotation` in
   * degrees). On a touch screen the same events describe touches the pointer
   * events already carry, so they are ignored there.
   */
  private handleSafariGesture(event: Event, kind: "start" | "change" | "end"): void {
    event.preventDefault();
    const gesture = event as Event & { scale?: number; rotation?: number; clientX?: number; clientY?: number };
    if (this.hasTouchPointers()) {
      return;
    }
    const cameraRuntime = this.host.cameraRuntime;
    if (kind === "start") {
      this.rect = this.surface.getBoundingClientRect();
      this.safariGesture = { lastScale: 1, lastRotation: 0 };
      return;
    }
    const state = this.safariGesture;
    if (state === null) {
      return;
    }
    if (kind === "end") {
      this.safariGesture = null;
      this.setInteractionActive(false, "mapPinch");
      this.setInteractionActive(false, "mapRotation");
      return;
    }
    if (cameraRuntime.currentCameraState() === null) {
      return;
    }
    const scale = gesture.scale ?? 1;
    const rotation = ((gesture.rotation ?? 0) * Math.PI) / 180;
    if (scale !== state.lastScale && state.lastScale > 0 && scale > 0) {
      if (!this.activeSources.has("mapPinch")) {
        this.setInteractionActive(true, "mapPinch");
      }
      const anchor: Vec2 = [(gesture.clientX ?? this.rect.left + this.rect.width / 2) - this.rect.left, (gesture.clientY ?? this.rect.top + this.rect.height / 2) - this.rect.top];
      cameraRuntime.zoomCameraByScale(scale / state.lastScale, 0, anchor);
      state.lastScale = scale;
    }
    if (rotation !== state.lastRotation) {
      if (!this.activeSources.has("mapRotation")) {
        this.setInteractionActive(true, "mapRotation");
      }
      cameraRuntime.rotateCameraYaw((rotation - state.lastRotation) * cameraRuntime.currentSettings.camera.rotationGestureSensitivity);
      state.lastRotation = rotation;
    }
  }

  // Interaction state

  private setInteractionActive(isActive: boolean, source: InteractionSource): void {
    if (isActive) {
      this.host.cameraAnimationRuntime.cancelAnimations();
      this.activeSources.add(source);
    } else {
      if (!this.activeSources.has(source)) {
        return;
      }
      this.activeSources.delete(source);
    }
    this.host.interactionRuntime.setActive(isActive, source, true);
  }

  private mapPointerIds(): number[] {
    const ids: number[] = [];
    for (const pointer of this.pointers.values()) {
      if (pointer.role === "map" && pointer.type !== "mouse") {
        ids.push(pointer.id);
      }
    }
    return ids;
  }

  private hasTouchPointers(): boolean {
    for (const pointer of this.pointers.values()) {
      if (pointer.type === "touch") {
        return true;
      }
    }
    return false;
  }

  private pointOf(event: { readonly clientX: number; readonly clientY: number }): Vec2 {
    return [event.clientX - this.rect.left, event.clientY - this.rect.top];
  }

  private clearTimer(handle: unknown): void {
    if (handle !== null) {
      this.timers.clearTimeout(handle);
    }
  }
}

function centroid(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
}

function wrapAngle(angle: number): number {
  let wrapped = angle;
  while (wrapped > Math.PI) {
    wrapped -= 2 * Math.PI;
  }
  while (wrapped < -Math.PI) {
    wrapped += 2 * Math.PI;
  }
  return wrapped;
}

/**
 * The pointer's velocity at `time`, in CSS pixels per second, over the
 * samples of the last `velocityWindow`: zero for a pointer that rested
 * before it lifted.
 */
function releaseVelocity(pointer: TrackedPointer, time: number): Vec2 {
  const samples = pointer.samples.filter((sample) => time - sample[0] <= velocityWindow);
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || samples.length < 2) {
    return [0, 0];
  }
  const deltaTime = last[0] - first[0];
  if (!(deltaTime > 0)) {
    return [0, 0];
  }
  return [(last[1] - first[1]) / deltaTime, (last[2] - first[2]) / deltaTime];
}

/** The wheel's vertical movement in pixels, whatever unit the browser reported it in. */
function wheelPixels(event: WheelEvent): number {
  switch (event.deltaMode) {
    case 1:
      return (event.deltaY * wheelPixelsPerZoomLevel) / wheelLinesPerZoomLevel;
    case 2:
      return event.deltaY * wheelPixelsPerZoomLevel;
    default:
      return event.deltaY;
  }
}

/**
 * The zoom a wheel event asks for, in levels: a trackpad's pixels at 150 a
 * level (the Mac controller's precise divisor), a wheel's lines at three a
 * notch and a third of a level a notch (its line divisor), a page a level.
 * A positive `deltaY` scrolls down, which zooms out.
 */
export function wheelZoomDelta(event: Pick<WheelEvent, "deltaY" | "deltaMode">): number {
  return -wheelPixels(event as WheelEvent) / wheelPixelsPerZoomLevel;
}
