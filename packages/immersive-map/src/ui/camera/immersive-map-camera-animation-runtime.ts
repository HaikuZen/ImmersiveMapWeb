// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraBearingFollowMath } from "../../math/camera-bearing-follow-math.ts";
import { CameraBearingFollow, CameraBearingFollowConfiguration } from "../../camera/camera-bearing-follow.ts";
import { CameraPitchFollow, CameraPitchFollowConfiguration } from "../../camera/camera-pitch-follow.ts";
import { GlobeUprightPull } from "../../camera/globe-upright-pull.ts";
import type { CameraFlightOptions, ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { ImmersiveMapGeoPath } from "../../geo/immersive-map-geo-path.ts";
import type { ImmersiveMapPathAnimationCurve } from "../../geo/immersive-map-path-animation-curve.ts";
import { GlobeCameraPanInertiaMath } from "../../math/globe-camera-pan-inertia-math.ts";
import type { Vec2 } from "../../math/vec.ts";
import { GlobeCameraPanInertia, GlobeCameraPanInertiaConfiguration } from "../gestures/globe-camera-pan-inertia.ts";
import type { CameraRenderRequests } from "../render-loop-pacing.ts";
import type { CameraCompletion } from "./immersive-map-camera-controller.ts";
import { type CameraAnimationOwner, ImmersiveMapCameraFlightController } from "./immersive-map-camera-flight-controller.ts";
import type { ImmersiveMapCameraFollowOptions } from "./immersive-map-camera-follow-options.ts";
import { ImmersiveMapCameraPathFollowController } from "./immersive-map-camera-path-follow-controller.ts";
import type { ImmersiveMapCameraRuntime } from "./immersive-map-camera-runtime.ts";
import type { ImmersiveMapInteractionRuntime } from "./immersive-map-interaction-runtime.ts";

/**
 * Owns the time-based camera animations of one map: the flight, the path
 * follow, the globe pan inertia, the pitch and bearing follows, the elastic
 * bounds' pull and the globe's upright pull. The map advances them once per
 * frame (`advanceAnimationsIfNeeded`) before it resolves the frame's camera,
 * and the runtime keeps the render loop's camera animation activity set
 * while any of them runs.
 *
 * Times are seconds on the clock the render loop runs on (`now`).
 */
export class ImmersiveMapCameraAnimationRuntime implements CameraAnimationOwner {
  private readonly cameraRuntime: ImmersiveMapCameraRuntime;
  private readonly interactionRuntime: ImmersiveMapInteractionRuntime;
  private readonly render: CameraRenderRequests;
  private readonly now: () => number;
  private readonly flightController: ImmersiveMapCameraFlightController;
  private readonly pathFollowController: ImmersiveMapCameraPathFollowController;
  private readonly globeCameraPanInertia: GlobeCameraPanInertia;
  private globeCameraPanInertiaIsActive = false;
  private readonly cameraPitchFollow: CameraPitchFollow;
  private cameraPitchFollowIsActive = false;
  private readonly cameraBearingFollow: CameraBearingFollow;
  private cameraBearingFollowIsActive = false;
  private boundsPullIsActive = false;
  private boundsPullLastTickTime: number | null = null;
  private globeUprightPullIsActive = false;
  private globeUprightPullLastTickTime: number | null = null;

  constructor(cameraRuntime: ImmersiveMapCameraRuntime, interactionRuntime: ImmersiveMapInteractionRuntime, render: CameraRenderRequests, now: () => number) {
    this.cameraRuntime = cameraRuntime;
    this.interactionRuntime = interactionRuntime;
    this.render = render;
    this.now = now;
    this.flightController = new ImmersiveMapCameraFlightController(cameraRuntime, interactionRuntime, this, render);
    this.pathFollowController = new ImmersiveMapCameraPathFollowController(cameraRuntime, interactionRuntime, this, render);
    this.globeCameraPanInertia = new GlobeCameraPanInertia(this.makeGlobeCameraPanInertiaConfiguration());
    this.cameraPitchFollow = new CameraPitchFollow(this.makeCameraPitchFollowConfiguration());
    this.cameraBearingFollow = new CameraBearingFollow(this.makeCameraBearingFollowConfiguration());
  }

  get isCameraFlightActive(): boolean {
    return this.flightController.isActive;
  }

  get isCameraPathFollowActive(): boolean {
    return this.pathFollowController.isActive;
  }

  /** Whether a tilt's easing toward its target pitch is under way. */
  get isCameraPitchFollowActive(): boolean {
    return this.cameraPitchFollowIsActive;
  }

  /** Whether a turn's easing toward its target bearing is under way. */
  get isCameraBearingFollowActive(): boolean {
    return this.cameraBearingFollowIsActive;
  }

  get isGlobeCameraPanInertiaActive(): boolean {
    return this.globeCameraPanInertiaIsActive;
  }

  /** Takes the camera settings over after `ImmersiveMapCameraRuntime.updateSettings`. */
  updateSettings(): void {
    this.globeCameraPanInertiaIsActive = this.globeCameraPanInertia.updateConfiguration(this.makeGlobeCameraPanInertiaConfiguration());
    this.cameraPitchFollowIsActive = this.cameraPitchFollow.updateConfiguration(this.makeCameraPitchFollowConfiguration());
    this.cameraBearingFollowIsActive = this.cameraBearingFollow.updateConfiguration(this.makeCameraBearingFollowConfiguration());
    this.refreshRenderingState();
  }

  /**
   * Sets target angles (bearing and pitch) from the camera control, toward
   * which the actual angles are eased per frame. Interrupts an active camera
   * flight, since manual control wins.
   */
  setCameraAngleTarget(bearing: number, pitch: number, currentTime: number = this.now()): void {
    if (this.flightController.isActive) {
      this.flightController.cancel(true);
    }
    // Manual angle control wins over a traversal, same as over a flight.
    this.pathFollowController.cancel(true);
    this.setBearingTarget(bearing, currentTime);
    this.setPitchTarget(pitch, currentTime);
  }

  /**
   * Accepts a target pitch. Instead of applying instantly, it sets a goal
   * toward which the actual pitch is eased per frame. If the follow is
   * disabled, applies instantly.
   */
  /**
   * The pitch a tilt gesture adds its step to: the target the follow is
   * still heading to, else the camera's pitch. Swift adds the step to the
   * camera's current pitch, which lags the target by the follow, so every
   * step lost what the follow had not yet covered: a drag tilted about a
   * third of what `tiltGestureSensitivity` asks, and the tilt stopped as soon
   * as the pointer did. From the target the whole drag counts and the camera
   * eases into its end.
   */
  pitchGestureBase(): number | null {
    return this.cameraPitchFollow.pendingTarget ?? this.cameraRuntime.currentPitch;
  }

  setPitchTarget(pitch: number, currentTime: number = this.now()): void {
    // A target above what the globe's upright pull allows would only be
    // pulled back, so the tilt stops there.
    const maximumPitch = Math.min(this.cameraRuntime.currentMaximumPitch(), this.cameraRuntime.currentGlobeUprightWindow()?.maximumPitch ?? Number.POSITIVE_INFINITY);
    const clampedTarget = Math.min(Math.max(this.cameraRuntime.currentMinimumPitch(), pitch), maximumPitch);
    if (!this.cameraPitchFollow.retarget(clampedTarget, currentTime)) {
      this.cameraPitchFollowIsActive = false;
      this.cameraRuntime.setCameraPitch(clampedTarget);
      this.refreshRenderingState();
      return;
    }
    this.cameraPitchFollowIsActive = true;
    this.refreshRenderingState();
    this.render.requestFrame();
  }

  /**
   * Accepts a target bearing. The actual bearing is eased toward the goal per
   * frame along the shortest angular path. If the follow is disabled,
   * applies instantly.
   */
  /**
   * A turn by a mouse drag, eased by the bearing follow. A mouse is read at
   * its own rate, so the distance it reports per frame wanders by a tenth to
   * a quarter under a steady hand, and a turn applied straight to the camera
   * (as the Swift Mac gesture applies it) shows that as a slipping speed. The
   * step is added to the target the follow is still heading to, so none of
   * the drag is lost, and the follow's half-life smooths the uneven steps.
   */
  rotateByGesture(delta: number, currentTime: number = this.now()): void {
    const base = this.cameraBearingFollow.pendingTarget ?? this.cameraRuntime.currentBearing;
    if (base === null) {
      return;
    }
    this.setBearingTarget(CameraBearingFollowMath.normalized(base + delta), currentTime);
  }

  setBearingTarget(bearing: number, currentTime: number = this.now()): void {
    const maximumAbsoluteBearing = Math.min(
      this.cameraRuntime.currentMaximumAbsoluteBearing(),
      this.cameraRuntime.currentGlobeUprightWindow()?.maximumAbsoluteBearing ?? Math.PI,
    );
    const clampedTarget = Math.min(Math.max(bearing, -maximumAbsoluteBearing), maximumAbsoluteBearing);
    if (!this.cameraBearingFollow.retarget(clampedTarget, currentTime)) {
      this.cameraBearingFollowIsActive = false;
      this.cameraRuntime.setCameraBearing(clampedTarget);
      this.refreshRenderingState();
      return;
    }
    this.cameraBearingFollowIsActive = true;
    this.refreshRenderingState();
    this.render.requestFrame();
  }

  cancelCameraPitchFollow(): void {
    this.cameraPitchFollow.cancel();
    this.cameraPitchFollowIsActive = false;
    this.refreshRenderingState();
  }

  cancelCameraBearingFollow(): void {
    this.cameraBearingFollow.cancel();
    this.cameraBearingFollowIsActive = false;
    this.refreshRenderingState();
  }

  startCameraFlight(cameraPosition: ImmersiveMapCameraPosition, options: CameraFlightOptions, completion: CameraCompletion | null, currentTime: number = this.now()): void {
    this.flightController.start(cameraPosition, options, completion, currentTime);
  }

  cancelCameraFlight(notifyCompletion = true): void {
    this.flightController.cancel(notifyCompletion);
  }

  startCameraPathFollow(
    path: ImmersiveMapGeoPath,
    duration: number,
    curve: ImmersiveMapPathAnimationCurve,
    options: ImmersiveMapCameraFollowOptions,
    completion: CameraCompletion | null,
    currentTime: number = this.now(),
  ): void {
    this.pathFollowController.start(path, duration, curve, options, completion, currentTime);
  }

  cancelCameraPathFollow(notifyCompletion = true): void {
    this.pathFollowController.cancel(notifyCompletion);
  }

  advanceCameraPathFollowIfNeeded(currentTime: number): void {
    this.pathFollowController.advanceIfNeeded(currentTime);
  }

  advanceCameraFlightIfNeeded(currentTime: number): void {
    this.flightController.advanceIfNeeded(currentTime);
  }

  /** The pan's release on the globe: starts the inertia from `initialVelocity`, in CSS pixels per second. The flat map has none. */
  startGlobeCameraPanInertiaIfNeeded(initialVelocity: Vec2, currentTime: number = this.now()): void {
    if (!this.cameraRuntime.isSphericalRenderSurfaceActive()) {
      this.cancelGlobeCameraPanInertia();
      return;
    }
    const didStart = this.globeCameraPanInertia.start(initialVelocity, currentTime);
    this.globeCameraPanInertiaIsActive = didStart;
    this.refreshRenderingState();
    if (didStart) {
      this.render.requestFrame();
    }
  }

  cancelGlobeCameraPanInertia(): void {
    this.globeCameraPanInertia.cancel();
    this.globeCameraPanInertiaIsActive = false;
    this.refreshRenderingState();
  }

  /** Cancels the app's own camera motion, a flight or a path follow, and leaves the gestures' easing and inertia running. */
  cancelCameraMovements(): void {
    this.flightController.cancel(true);
    this.pathFollowController.cancel(true);
  }

  cancelAnimations(): void {
    this.cancelGlobeCameraPanInertia();
    this.cancelCameraPitchFollow();
    this.cancelCameraBearingFollow();
    // The follow goes last: its completion runs synchronously, and a camera
    // command the app issues from there must not be undone by the rest of
    // this sequence.
    this.flightController.cancel(true);
    this.pathFollowController.cancel(true);
  }

  /** One frame of every camera animation, at `currentTime` seconds. The map calls it before it resolves the frame's camera. */
  advanceAnimationsIfNeeded(currentTime: number): void {
    this.advanceCameraPitchFollowIfNeeded(currentTime);
    this.advanceCameraBearingFollowIfNeeded(currentTime);
    this.advanceGlobeCameraPanInertiaIfNeeded(currentTime);
    this.pathFollowController.advanceIfNeeded(currentTime);
    this.flightController.advanceIfNeeded(currentTime);
    // Last, so the pulls act on the camera every other animation left this
    // frame, and a flight that ended hands over in the same frame.
    this.advanceBoundsPullIfNeeded(currentTime);
    this.advanceGlobeUprightPullIfNeeded(currentTime);
  }

  reset(): void {
    this.globeCameraPanInertia.cancel();
    this.globeCameraPanInertiaIsActive = false;
    this.cameraPitchFollow.cancel();
    this.cameraPitchFollowIsActive = false;
    this.cameraBearingFollow.cancel();
    this.cameraBearingFollowIsActive = false;
    this.pathFollowController.reset();
    this.flightController.reset();
    this.boundsPullIsActive = false;
    this.boundsPullLastTickTime = null;
    this.globeUprightPullIsActive = false;
    this.globeUprightPullLastTickTime = null;
    this.refreshRenderingState();
  }

  refreshRenderingState(): void {
    this.render.setCameraAnimationRenderingActive(
      this.globeCameraPanInertiaIsActive ||
        this.flightController.isActive ||
        this.pathFollowController.isActive ||
        this.cameraPitchFollowIsActive ||
        this.cameraBearingFollowIsActive ||
        this.boundsPullIsActive ||
        this.globeUprightPullIsActive,
    );
  }

  private makeGlobeCameraPanInertiaConfiguration(): GlobeCameraPanInertiaConfiguration {
    const settings = this.cameraRuntime.currentSettings.camera;
    return new GlobeCameraPanInertiaConfiguration(
      settings.globePanInertiaEnabled,
      settings.globePanInertiaHalfLife,
      settings.globePanInertiaActivationVelocity,
      settings.globePanInertiaStopVelocity,
      settings.globePanInertiaMaxInitialVelocity,
    );
  }

  private makeCameraPitchFollowConfiguration(): CameraPitchFollowConfiguration {
    const settings = this.cameraRuntime.currentSettings.camera;
    return new CameraPitchFollowConfiguration(settings.pitchFollowEnabled, settings.pitchFollowHalfLife);
  }

  private makeCameraBearingFollowConfiguration(): CameraBearingFollowConfiguration {
    const settings = this.cameraRuntime.currentSettings.camera;
    return new CameraBearingFollowConfiguration(settings.bearingFollowEnabled, settings.bearingFollowHalfLife);
  }

  private advanceCameraPitchFollowIfNeeded(currentTime: number): void {
    if (!this.cameraPitchFollowIsActive) {
      return;
    }
    // A camera flight owns the entire camera pose (including pitch), so the follow yields to it.
    const currentPitch = this.cameraRuntime.currentPitch;
    if (this.flightController.isActive || currentPitch === null) {
      this.cancelCameraPitchFollow();
      return;
    }
    const step = this.cameraPitchFollow.advance(currentPitch, currentTime);
    if (step.pitch !== currentPitch) {
      this.cameraRuntime.setCameraPitch(step.pitch);
    }
    this.cameraPitchFollowIsActive = step.isActive;
    if (!step.isActive) {
      this.refreshRenderingState();
    }
  }

  private advanceCameraBearingFollowIfNeeded(currentTime: number): void {
    if (!this.cameraBearingFollowIsActive) {
      return;
    }
    // A camera flight owns the entire camera pose (including bearing), so the follow yields to it.
    const currentBearing = this.cameraRuntime.currentBearing;
    if (this.flightController.isActive || currentBearing === null) {
      this.cancelCameraBearingFollow();
      return;
    }
    const step = this.cameraBearingFollow.advance(currentBearing, currentTime, this.cameraRuntime.currentMaximumAbsoluteBearing());
    if (step.bearing !== currentBearing) {
      this.cameraRuntime.setCameraBearing(step.bearing);
    }
    this.cameraBearingFollowIsActive = step.isActive;
    if (!step.isActive) {
      this.refreshRenderingState();
    }
  }

  private advanceGlobeCameraPanInertiaIfNeeded(currentTime: number): void {
    if (!this.globeCameraPanInertiaIsActive) {
      this.refreshRenderingState();
      return;
    }
    if (this.interactionRuntime.hasActiveUserInteraction || !this.cameraRuntime.isSphericalRenderSurfaceActive()) {
      this.cancelGlobeCameraPanInertia();
      return;
    }
    const step = this.globeCameraPanInertia.advance(currentTime);
    this.globeCameraPanInertiaIsActive = step.isActive;
    if (step.translation[0] !== 0 || step.translation[1] !== 0) {
      const scale = this.cameraRuntime.currentSettings.camera.gesturePanTranslationScale;
      this.cameraRuntime.panCamera(step.translation[0] * scale, step.translation[1] * scale);
    }
    if (!step.isActive) {
      this.refreshRenderingState();
    }
  }

  /**
   * The elastic bounds pull on every frame, gestures and the pan inertia
   * included, so the pull reads as a constant force a drag works against.
   * Only a flight or a path follow owns the center outright, and the pull
   * waits for it to finish. A center inside the area costs one clamp and
   * starts nothing.
   */
  private advanceBoundsPullIfNeeded(currentTime: number): void {
    if (this.flightController.isActive || this.pathFollowController.isActive) {
      this.boundsPullLastTickTime = null;
      this.setBoundsPullActive(false);
      return;
    }
    // The same frame-gap cap as the pan inertia, so a hitch does not snap the
    // camera back in one step.
    const last = this.boundsPullLastTickTime;
    const deltaTime = last === null ? 0 : GlobeCameraPanInertiaMath.clampedDeltaTime(currentTime - last);
    const isPulling = this.cameraRuntime.advanceBoundsPull(deltaTime);
    this.boundsPullLastTickTime = isPulling ? currentTime : null;
    this.setBoundsPullActive(isPulling);
  }

  private setBoundsPullActive(isActive: boolean): void {
    if (this.boundsPullIsActive === isActive) {
      return;
    }
    this.boundsPullIsActive = isActive;
    this.refreshRenderingState();
  }

  /**
   * The globe's upright pull on every frame, gestures included, the way the
   * bounds pull runs: zooming out straightens the globe while the pinch is
   * still under way, and a rotation works against the pull and springs back
   * when it ends. A flight or a path follow owns the angles outright, and the
   * pull waits for it to finish.
   */
  private advanceGlobeUprightPullIfNeeded(currentTime: number): void {
    const window = this.cameraRuntime.currentGlobeUprightWindow();
    const bearing = this.cameraRuntime.currentBearing;
    const pitch = this.cameraRuntime.currentPitch;
    if (this.flightController.isActive || this.pathFollowController.isActive || window === null || bearing === null || pitch === null) {
      this.globeUprightPullLastTickTime = null;
      this.setGlobeUprightPullActive(false);
      return;
    }
    const last = this.globeUprightPullLastTickTime;
    const deltaTime = last === null ? 0 : GlobeCameraPanInertiaMath.clampedDeltaTime(currentTime - last);
    const halfLife = this.cameraRuntime.currentSettings.camera.globeUprightPull?.halfLife ?? 0;
    const step = GlobeUprightPull.step(bearing, pitch, window, deltaTime, halfLife);
    // A follow whose target was set under a wider window would hold the
    // angle against the pull for good, so the pull takes the angle over.
    if (step.bearing !== bearing) {
      this.cancelCameraBearingFollow();
      this.cameraRuntime.setCameraBearing(step.bearing);
    }
    if (step.pitch !== pitch) {
      this.cancelCameraPitchFollow();
      this.cameraRuntime.setCameraPitch(step.pitch);
    }
    this.globeUprightPullLastTickTime = step.isPulling ? currentTime : null;
    this.setGlobeUprightPullActive(step.isPulling);
  }

  private setGlobeUprightPullActive(isActive: boolean): void {
    if (this.globeUprightPullIsActive === isActive) {
      return;
    }
    this.globeUprightPullIsActive = isActive;
    this.refreshRenderingState();
  }
}
