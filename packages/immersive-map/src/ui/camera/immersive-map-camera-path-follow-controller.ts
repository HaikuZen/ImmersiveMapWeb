// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { GeoPathMetrics, type GeoPathSample } from "../../geo/geo-path-sampler.ts";
import type { ImmersiveMapGeoPath } from "../../geo/immersive-map-geo-path.ts";
import { type ImmersiveMapPathAnimationCurve, pathAnimationFraction } from "../../geo/immersive-map-path-animation-curve.ts";
import { CameraBearingFollowMath } from "../../math/camera-bearing-follow-math.ts";
import { CameraPathFollowMath } from "../../math/camera-path-follow-math.ts";
import type { CameraRenderRequests } from "../render-loop-pacing.ts";
import type { CameraCompletion } from "./immersive-map-camera-controller.ts";
import type { CameraAnimationOwner } from "./immersive-map-camera-flight-controller.ts";
import type { ImmersiveMapCameraFollowOptions } from "./immersive-map-camera-follow-options.ts";
import type { ImmersiveMapCameraRuntime } from "./immersive-map-camera-runtime.ts";
import type { ImmersiveMapInteractionRuntime } from "./immersive-map-interaction-runtime.ts";

interface Traversal {
  readonly metrics: GeoPathMetrics;
  readonly curve: ImmersiveMapPathAnimationCurve;
  readonly options: ImmersiveMapCameraFollowOptions;
  readonly startTime: number;
  readonly duration: number;
}

/**
 * Drives the camera along an `ImmersiveMapGeoPath`: the traversal state, the
 * per-frame catch-up toward the point of the path, and the completion.
 *
 * The camera resolves its own point of the path from the shared
 * `GeoPathMetrics` and `ImmersiveMapPathAnimationCurve`, the same pair a
 * scene model animation uses, so a model and the camera started together
 * travel in step without a channel between the render side and here.
 */
export class ImmersiveMapCameraPathFollowController {
  private traversal: Traversal | null = null;
  private lastTickTime = 0;
  private completion: CameraCompletion | null = null;

  constructor(
    private readonly cameraRuntime: ImmersiveMapCameraRuntime,
    private readonly interactionRuntime: ImmersiveMapInteractionRuntime,
    private readonly owner: CameraAnimationOwner,
    private readonly render: CameraRenderRequests,
  ) {}

  get isActive(): boolean {
    return this.traversal !== null;
  }

  start(
    path: ImmersiveMapGeoPath,
    duration: number,
    curve: ImmersiveMapPathAnimationCurve,
    options: ImmersiveMapCameraFollowOptions,
    completion: CameraCompletion | null,
    currentTime: number,
  ): void {
    const metrics = GeoPathMetrics.make(path);
    if (this.cameraRuntime.currentCameraState() === null || metrics === null) {
      completion?.(false);
      return;
    }

    // The superseded completion is taken before anything can fire it and
    // called last: a `follow` or `fly` issued from inside it must act on
    // settled state instead of being overwritten by this install.
    const superseded = this.completion;
    this.completion = null;
    this.traversal = null;

    // Cancels a flight and the inertia, resolving their completions before
    // this traversal takes the camera.
    this.owner.cancelAnimations();

    if (!(duration > 0)) {
      this.applyCameraState(metrics.sample(1), 1, options);
      superseded?.(false);
      completion?.(true);
      return;
    }

    this.traversal = { metrics, curve, options, startTime: currentTime, duration };
    this.lastTickTime = currentTime;
    this.completion = completion;
    this.owner.refreshRenderingState();
    this.render.requestFrame();
    superseded?.(false);
  }

  cancel(notifyCompletion = true): void {
    if (this.traversal === null && this.completion === null) {
      this.owner.refreshRenderingState();
      return;
    }
    this.traversal = null;
    if (notifyCompletion) {
      this.finish(false);
    } else {
      this.completion = null;
      this.owner.refreshRenderingState();
    }
  }

  advanceIfNeeded(currentTime: number): void {
    const traversal = this.traversal;
    if (traversal === null) {
      return;
    }
    // The user taking the camera wins, exactly as it does over a flight.
    if (this.interactionRuntime.hasActiveUserInteraction || this.cameraRuntime.currentCameraState() === null) {
      this.cancel();
      return;
    }

    const elapsed = currentTime - traversal.startTime;
    const fraction = pathAnimationFraction(traversal.curve, elapsed, traversal.duration);
    const isFinalStep = elapsed >= traversal.duration;
    const catchUpFraction = CameraPathFollowMath.catchUpFraction(currentTime - this.lastTickTime, traversal.options.smoothingHalfLife, !isFinalStep);
    this.lastTickTime = currentTime;

    this.applyCameraState(traversal.metrics.sample(fraction), catchUpFraction, traversal.options);

    // No frame request here: `setCameraState` already invalidates, and the
    // camera animation activity keeps the loop running.
    if (!isFinalStep) {
      this.owner.refreshRenderingState();
      return;
    }

    // No snap onto the endpoint: with smoothing the camera trails the point
    // by design, and jumping the residual gap would undo the smoothing in one
    // frame. `smoothingHalfLife: 0` lands exactly on it.
    this.traversal = null;
    this.finish(true);
  }

  reset(): void {
    this.traversal = null;
    this.completion = null;
    this.owner.refreshRenderingState();
  }

  private applyCameraState(sample: GeoPathSample, catchUpFraction: number, options: ImmersiveMapCameraFollowOptions): void {
    const currentState = this.cameraRuntime.currentCameraState();
    if (currentState === null) {
      return;
    }
    const targetCenter = CameraPathFollowMath.centerWorldMercator(sample.coordinate);
    const center = CameraPathFollowMath.steppedCenter(currentState.centerWorldMercator, targetCenter, catchUpFraction);
    const zoom = options.zoom === null ? currentState.zoom : CameraPathFollowMath.steppedScalar(currentState.zoom, options.zoom, catchUpFraction);
    const pitch = options.pitch === null ? currentState.pitch : CameraPathFollowMath.steppedScalar(currentState.pitch, options.pitch, catchUpFraction);

    let bearing: number;
    switch (options.bearing.kind) {
      case "unchanged":
        bearing = currentState.bearing;
        break;
      case "fixed":
        bearing = steppedBearing(currentState.bearing, options.bearing.bearing, catchUpFraction);
        break;
      case "course":
        bearing = steppedBearing(currentState.bearing, bearingPuttingCourseUpTheScreen(sample.headingDegrees), catchUpFraction);
        break;
    }

    this.cameraRuntime.setCameraState(ImmersiveMapCameraState.make(center, zoom, bearing, pitch));
  }

  private finish(success: boolean): void {
    const completion = this.completion;
    this.completion = null;
    this.owner.refreshRenderingState();
    completion?.(success);
  }
}

/**
 * The camera's bearing is the negation of the compass direction that ends
 * up pointing up the screen: the pose resolver rotates the up vector by
 * `bearing` about +Z in an (east, north) frame, so screen-up on the ground is
 * `(-sin bearing, cos bearing)`. Putting a course up the screen therefore
 * means steering to minus that course.
 */
export function bearingPuttingCourseUpTheScreen(headingDegrees: number): number {
  return (-headingDegrees * Math.PI) / 180.0;
}

/**
 * Bearing is cyclic, so the gap is closed along the shortest arc. Reading
 * `current` back from the camera every frame means a bearing the globe
 * constraints clamped is absorbed instead of fought.
 */
function steppedBearing(current: number, target: number, catchUpFraction: number): number {
  const delta = CameraBearingFollowMath.shortestDelta(current, target);
  return current + delta * Math.min(Math.max(catchUpFraction, 0), 1);
}
