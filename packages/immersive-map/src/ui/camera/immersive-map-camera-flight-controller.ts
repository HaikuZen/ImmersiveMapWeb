// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraFlightAnimator, type ResolvedCameraFlightRouteStyle } from "../../camera/camera-flight-animator.ts";
import type { CameraFlightOptions, CameraFlightRouteStyle, ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { CameraFlightMath } from "../../math/camera-flight-math.ts";
import type { CameraRenderRequests } from "../render-loop-pacing.ts";
import type { CameraCompletion } from "./immersive-map-camera-controller.ts";
import type { ImmersiveMapCameraRuntime } from "./immersive-map-camera-runtime.ts";
import type { ImmersiveMapInteractionRuntime } from "./immersive-map-interaction-runtime.ts";

/** What a flight and a path follow reach of the animation runtime that owns them. */
export interface CameraAnimationOwner {
  cancelAnimations(): void;
  refreshRenderingState(): void;
}

/**
 * Drives the camera flight state machine: starting the `CameraFlightAnimator`,
 * the target position, the completion callback and the stepwise application
 * of the animated camera state.
 */
export class ImmersiveMapCameraFlightController {
  private readonly animator = new CameraFlightAnimator();
  private targetPosition: ImmersiveMapCameraPosition | null = null;
  private completion: CameraCompletion | null = null;

  constructor(
    private readonly cameraRuntime: ImmersiveMapCameraRuntime,
    private readonly interactionRuntime: ImmersiveMapInteractionRuntime,
    private readonly owner: CameraAnimationOwner,
    private readonly render: CameraRenderRequests,
  ) {}

  get isActive(): boolean {
    return this.animator.isActive;
  }

  start(cameraPosition: ImmersiveMapCameraPosition, options: CameraFlightOptions, completion: CameraCompletion | null, currentTime: number): void {
    const startState = this.cameraRuntime.currentCameraState();
    if (startState === null) {
      completion?.(false);
      return;
    }

    this.owner.cancelAnimations();
    const targetState = ImmersiveMapCameraState.fromPosition(cameraPosition, this.cameraRuntime.currentSettings.camera);
    if (!CameraFlightMath.hasMeaningfulDelta(startState, targetState) || options.duration <= 0) {
      this.applyFinalCameraPosition(cameraPosition);
      completion?.(true);
      return;
    }

    const routeStyle = this.resolveRouteStyle(options.routeStyle, startState, targetState);
    if (!this.animator.start(startState, targetState, options.duration, routeStyle, options.altitudeStyle, currentTime)) {
      this.applyFinalCameraPosition(cameraPosition);
      completion?.(true);
      return;
    }

    this.targetPosition = cameraPosition;
    this.completion = completion;
    this.owner.refreshRenderingState();
    this.render.requestFrame();
  }

  cancel(notifyCompletion = true): void {
    if (!this.animator.isActive && this.completion === null) {
      this.owner.refreshRenderingState();
      return;
    }
    this.animator.cancel();
    if (notifyCompletion) {
      this.finish(false);
    } else {
      this.completion = null;
      this.targetPosition = null;
      this.owner.refreshRenderingState();
    }
  }

  advanceIfNeeded(currentTime: number): void {
    if (!this.animator.isActive) {
      this.owner.refreshRenderingState();
      return;
    }
    if (this.interactionRuntime.hasActiveUserInteraction || this.cameraRuntime.currentCameraState() === null) {
      this.cancel();
      return;
    }
    const step = this.animator.advance(currentTime);
    if (step === null) {
      this.owner.refreshRenderingState();
      return;
    }
    this.cameraRuntime.setCameraState(step.cameraState);
    if (!step.didFinish) {
      this.owner.refreshRenderingState();
      return;
    }
    if (this.targetPosition !== null) {
      this.applyFinalCameraPosition(this.targetPosition);
    }
    this.finish(true);
  }

  reset(): void {
    this.animator.cancel();
    this.completion = null;
    this.targetPosition = null;
    this.owner.refreshRenderingState();
  }

  private resolveRouteStyle(
    routeStyle: CameraFlightRouteStyle,
    startState: ImmersiveMapCameraState,
    targetState: ImmersiveMapCameraState,
  ): ResolvedCameraFlightRouteStyle {
    switch (routeStyle) {
      case "mercatorShortestPath":
        return "mercatorShortestPath";
      case "greatCircle":
        return "greatCircle";
      case "automatic": {
        const startZoom = this.cameraRuntime.currentSettings.presentation.automaticTransitionStartZoom;
        const useGreatCircle = this.cameraRuntime.isSphericalRenderSurfaceActive() || Math.min(startState.zoom, targetState.zoom) < startZoom;
        return useGreatCircle ? "greatCircle" : "mercatorShortestPath";
      }
    }
  }

  private applyFinalCameraPosition(cameraPosition: ImmersiveMapCameraPosition): void {
    this.cameraRuntime.setCameraPosition(cameraPosition);
  }

  private finish(success: boolean): void {
    const completion = this.completion;
    this.completion = null;
    this.targetPosition = null;
    this.owner.refreshRenderingState();
    completion?.(success);
  }
}
