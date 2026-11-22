// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { ControlZoneSettings } from "../../configuration/camera-settings.ts";
import { PitchControlMath } from "../../math/pitch-control-math.ts";
import type { Vec2 } from "../../math/vec.ts";
import { ZoomControlMath } from "../../math/zoom-control-math.ts";
import type { ImmersiveMapCameraRuntimes } from "../camera/immersive-map-camera-runtimes.ts";
import type { CameraControlsSink } from "../camera/immersive-map-camera-runtime.ts";

/** What a zone drives: the camera, its animations and the interaction state. */
export type ControlZoneHost = Pick<ImmersiveMapCameraRuntimes, "cameraRuntime" | "cameraAnimationRuntime" | "interactionRuntime">;

/** A zone's rectangle in the map's CSS pixels, top-left origin. */
export interface ControlZoneFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The drag a zone captured, as the gesture controller reports it: the zone
 * owns the pointer from its press to its release, and the map pans nothing
 * under it.
 */
export interface ControlZoneDrag {
  /** The drag is recognized (the pointer moved past the slop). */
  began(): void;
  /** The vertical movement since the last call and the drag's vertical velocity, in CSS pixels (per second). */
  changed(translationY: number, velocityY: number): void;
  ended(): void;
}

/**
 * The pitch control zone in the bottom leading corner: a vertical drag
 * inside it tilts the camera instead of panning the map. On by default, set
 * through `CameraSettings.controlZones` (`settings.cameraControlZones`).
 *
 * The zones are hit regions of the map's canvas and draw nothing (Swift
 * `ControlZoneView` is a transparent view): only touch pointers reach them,
 * a mouse pans the whole map.
 */
export class PitchControlZone implements ControlZoneDrag {
  static readonly size: Vec2 = [88, 188];
  static readonly bottomInset = 0;
  static readonly leadingInset = 0;

  /** While disabled the zone captures nothing, so a drag in the corner pans the map exactly like a drag anywhere else. */
  isEnabled: boolean;
  private host: ControlZoneHost | null = null;
  private frameValue: ControlZoneFrame = { x: 0, y: 0, width: 0, height: 0 };
  private controlValue = 0;

  constructor(isEnabled: boolean) {
    this.isEnabled = isEnabled;
  }

  attach(host: ControlZoneHost | null): void {
    this.host = host;
  }

  get frame(): ControlZoneFrame {
    return this.frameValue;
  }

  /** Lays the zone out in a map of `width` by `height` CSS pixels. Leading is left. */
  layout(width: number, height: number): void {
    const [zoneWidth, zoneHeight] = PitchControlZone.size;
    this.frameValue = { x: PitchControlZone.leadingInset, y: height - PitchControlZone.bottomInset - zoneHeight, width: zoneWidth, height: zoneHeight };
  }

  contains(point: Vec2): boolean {
    return this.isEnabled && frameContains(this.frameValue, point);
  }

  /** Takes the zone's value from the camera, so a drag starts where the camera is. */
  syncValue(cameraPosition: ImmersiveMapCameraPosition | null, minimumPitch: number, maximumPitch: number): void {
    const value = cameraPosition === null ? maximumPitch : PitchControlMath.controlValue(cameraPosition.pitch, minimumPitch, maximumPitch);
    this.setControlValue(value, minimumPitch, maximumPitch, false);
  }

  began(): void {
    this.setInteractionActive(true);
  }

  changed(translationY: number): void {
    const minimumPitch = this.host?.cameraRuntime.currentMinimumPitch() ?? 0;
    const maximumPitch = this.host?.cameraRuntime.currentMaximumPitch() ?? 0;
    const delta = PitchControlMath.controlValueDelta(translationY, this.frameValue.height, minimumPitch, maximumPitch);
    this.setControlValue(this.controlValue + delta, minimumPitch, maximumPitch, true);
  }

  ended(): void {
    this.setInteractionActive(false);
  }

  private setInteractionActive(isActive: boolean): void {
    const host = this.host;
    if (host === null) {
      return;
    }
    if (isActive) {
      host.cameraAnimationRuntime.cancelAnimations();
    }
    host.interactionRuntime.setActive(isActive, "pitchControl", false, true);
  }

  private setControlValue(value: number, minimumPitch: number, maximumPitch: number, updateCamera: boolean): void {
    const clampedValue = PitchControlMath.clampedControlValue(value, minimumPitch, maximumPitch);
    this.controlValue = clampedValue;
    const host = this.host;
    if (!updateCamera || host === null || host.cameraRuntime.currentCameraState() === null) {
      return;
    }
    host.cameraAnimationRuntime.setPitchTarget(PitchControlMath.actualPitch(clampedValue, minimumPitch, maximumPitch));
  }
}

/**
 * The drag zoom zone in the bottom trailing corner: a vertical drag inside
 * it changes the camera's zoom instead of panning the map. On by default,
 * set through `CameraSettings.controlZones`. The wheel and the trackpad zoom
 * are unaffected by it. Touch pointers only.
 */
export class ZoomControlZone implements ControlZoneDrag {
  static readonly size: Vec2 = [132, 240];
  static readonly bottomInset = 0;
  static readonly trailingInset = 0;

  /** While disabled the zone captures nothing, so a drag in the corner pans the map exactly like a drag anywhere else. */
  isEnabled: boolean;
  private host: ControlZoneHost | null = null;
  private frameValue: ControlZoneFrame = { x: 0, y: 0, width: 0, height: 0 };

  constructor(isEnabled: boolean) {
    this.isEnabled = isEnabled;
  }

  attach(host: ControlZoneHost | null): void {
    this.host = host;
  }

  get frame(): ControlZoneFrame {
    return this.frameValue;
  }

  /** Lays the zone out in a map of `width` by `height` CSS pixels. Trailing is right. */
  layout(width: number, height: number): void {
    const [zoneWidth, zoneHeight] = ZoomControlZone.size;
    this.frameValue = {
      x: width - ZoomControlZone.trailingInset - zoneWidth,
      y: height - ZoomControlZone.bottomInset - zoneHeight,
      width: zoneWidth,
      height: zoneHeight,
    };
  }

  contains(point: Vec2): boolean {
    return this.isEnabled && frameContains(this.frameValue, point);
  }

  began(): void {
    this.setControlInteractionActive(true);
  }

  changed(translationY: number, velocityY: number): void {
    const host = this.host;
    if (host === null || host.cameraRuntime.currentCameraState() === null) {
      return;
    }
    const settings = host.cameraRuntime.currentSettings.camera;
    const delta = ZoomControlMath.zoomDelta(
      translationY,
      velocityY,
      this.frameValue.height,
      settings.dragZoomFactor,
      settings.dragZoomVelocityFactor,
      settings.dragZoomVelocityLimit,
    );
    host.cameraRuntime.zoomCameraByDelta(delta);
  }

  ended(): void {
    this.setControlInteractionActive(false);
  }

  private setControlInteractionActive(isActive: boolean): void {
    const host = this.host;
    if (host === null) {
      return;
    }
    if (isActive) {
      host.cameraAnimationRuntime.cancelAnimations();
    }
    host.interactionRuntime.setActive(isActive, "zoomControl", false, true);
  }
}

/**
 * Both zones of a map, and the camera's controls sink that keeps the pitch
 * zone's value in step. Pass it as `controls` to the camera runtimes, then
 * `attach` the runtimes, and give it to the `MapGestureController`.
 */
export class ControlZones implements CameraControlsSink {
  readonly pitchZone: PitchControlZone;
  readonly zoomZone: ZoomControlZone;

  constructor(settings: ControlZoneSettings, isHidden = false) {
    this.pitchZone = new PitchControlZone(settings.isPitchZoneEnabled && !isHidden);
    this.zoomZone = new ZoomControlZone(settings.isZoomZoneEnabled && !isHidden);
  }

  attach(host: ControlZoneHost | null): void {
    this.pitchZone.attach(host);
    this.zoomZone.attach(host);
  }

  /** The zones as configured, or none while the map's controls are hidden (`ControlsSettings.isHidden`). */
  applyControlZones(settings: ControlZoneSettings, isHidden: boolean): void {
    this.pitchZone.isEnabled = settings.isPitchZoneEnabled && !isHidden;
    this.zoomZone.isEnabled = settings.isZoomZoneEnabled && !isHidden;
  }

  layout(width: number, height: number): void {
    this.pitchZone.layout(width, height);
    this.zoomZone.layout(width, height);
  }

  /** The enabled zone under `point`, null over the bare map. */
  hitTest(point: Vec2): ControlZoneDrag | null {
    if (this.pitchZone.contains(point)) {
      return this.pitchZone;
    }
    if (this.zoomZone.contains(point)) {
      return this.zoomZone;
    }
    return null;
  }

  syncPitch(cameraPosition: ImmersiveMapCameraPosition | null, minimumPitch: number, maximumPitch: number): void {
    this.pitchZone.syncValue(cameraPosition, minimumPitch, maximumPitch);
  }
}

function frameContains(frame: ControlZoneFrame, point: Vec2): boolean {
  return point[0] >= frame.x && point[0] < frame.x + frame.width && point[1] >= frame.y && point[1] < frame.y + frame.height;
}
