// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraFlightAnimator, type ResolvedCameraFlightRouteStyle } from "../camera/camera-flight-animator.ts";
import type { FrameCameraStateResolver } from "../camera/frame-camera-state-resolver.ts";
import type { CameraFlightRouteStyle, ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { CameraFlightMath } from "../math/camera-flight-math.ts";
import type { CameraPresentationSettings } from "../presentation/camera-presentation-settings.ts";
import type { MapPresentationStateController } from "../presentation/map-presentation-state-controller.ts";
import type { ImmersiveMapCameraTourShot } from "../ui/camera/immersive-map-camera-tour-controller.ts";

/** How long a tour runs and how many frames it takes at a frame rate. */
export interface TourVideoTimelinePlan {
  readonly totalDuration: number;
  /** Frames to capture, both ends included: frame 0 at t = 0, the last at t >= `totalDuration`. */
  readonly frameCount: number;
}

interface Segment {
  readonly shot: ImmersiveMapCameraTourShot;
  readonly startTime: number;
  readonly flightDuration: number;
  readonly holdDuration: number;
  readonly flightEndTime: number;
  readonly endTime: number;
}

/**
 * The camera tour replayed for an offline export, a port of the Swift
 * `TourVideoTimelineDriver`.
 *
 * `ImmersiveMapCameraTourController` chains real-time flights over the wall
 * clock. This driver replays the same shot semantics (the establish jump,
 * one flight a shot, the exact target on arrival, the hold after each shot)
 * as a pure function of the export timeline's time, stepped frame by frame.
 *
 * The timing can be computed ahead because every flight lands exactly on its
 * target: segment N always starts from shot N-1's position (or the start
 * position), so a shot without a meaningful delta or with a duration of zero
 * or less takes no time, as the live controller completes it at once.
 */
export class TourVideoTimelineDriver {
  private readonly segments: readonly Segment[];
  private readonly animator = new CameraFlightAnimator();
  private currentSegmentIndex = 0;
  /** The segment whose flight the animator holds. */
  private flyingSegmentIndex = -1;
  /** The last segment set on its exact target (applied once). */
  private snappedSegmentIndex = -1;

  /**
   * `initialPosition` is where the tour starts: the establish position when
   * one was given, else the map's camera as it was.
   */
  constructor(
    shots: readonly ImmersiveMapCameraTourShot[],
    initialPosition: ImmersiveMapCameraPosition,
    private readonly settings: CameraPresentationSettings,
    private readonly renderCamera: FrameCameraStateResolver,
    private readonly presentationStateResolver: MapPresentationStateController,
  ) {
    this.segments = makeSegments(shots, initialPosition, settings);
    // The live tour's establish: an instant jump before the first shot.
    this.setCameraPosition(initialPosition);
  }

  get isFinished(): boolean {
    return this.currentSegmentIndex >= this.segments.length;
  }

  static makePlan(
    shots: readonly ImmersiveMapCameraTourShot[],
    initialPosition: ImmersiveMapCameraPosition,
    settings: CameraPresentationSettings,
    framesPerSecond: number,
  ): TourVideoTimelinePlan {
    const segments = makeSegments(shots, initialPosition, settings);
    const totalDuration = segments.at(-1)?.endTime ?? 0;
    const frameCount = Math.max(1, Math.ceil(totalDuration * framesPerSecond) + 1);
    return { totalDuration, frameCount };
  }

  /**
   * Applies the camera of the export timeline's `time`. Times are fed in
   * increasing order: a segment wholly behind `time` lands on its target even
   * when the frame step jumped past it.
   */
  advance(time: number): void {
    while (this.currentSegmentIndex < this.segments.length) {
      const segment = this.segments[this.currentSegmentIndex]!;
      if (time >= segment.endTime) {
        this.snapToTarget(segment);
        this.currentSegmentIndex += 1;
        continue;
      }
      if (time < segment.flightEndTime && segment.flightDuration > 0) {
        this.advanceFlight(segment, time);
      } else {
        // The hold of the shot: parked exactly on the target.
        this.snapToTarget(segment);
      }
      return;
    }
  }

  private advanceFlight(segment: Segment, time: number): void {
    if (this.flyingSegmentIndex !== this.currentSegmentIndex) {
      const startState = this.renderCamera.currentCameraState();
      const targetState = ImmersiveMapCameraState.fromPosition(segment.shot.position, this.settings.camera);
      const routeStyle = this.resolveRouteStyle(segment.shot.options.routeStyle, startState, targetState);
      // From the segment's scheduled start, not from its first frame, so the
      // progress is a function of the export timeline alone.
      const didStart = this.animator.start(startState, targetState, segment.flightDuration, routeStyle, segment.shot.options.altitudeStyle, segment.startTime);
      this.flyingSegmentIndex = this.currentSegmentIndex;
      if (!didStart) {
        // The clamped start can lose the delta the plan saw: land at once, as live.
        this.snapToTarget(segment);
        return;
      }
    }
    const step = this.animator.advance(time);
    if (step === null) return;
    this.setCameraState(step.cameraState);
    if (step.didFinish) this.snapToTarget(segment);
  }

  private snapToTarget(segment: Segment): void {
    if (this.snappedSegmentIndex >= this.currentSegmentIndex) return;
    this.snappedSegmentIndex = this.currentSegmentIndex;
    this.animator.cancel();
    this.setCameraPosition(segment.shot.position);
  }

  /** As `ImmersiveMapCameraFlightController.resolveRouteStyle`. */
  private resolveRouteStyle(routeStyle: CameraFlightRouteStyle, startState: ImmersiveMapCameraState, targetState: ImmersiveMapCameraState): ResolvedCameraFlightRouteStyle {
    switch (routeStyle) {
      case "mercatorShortestPath":
        return "mercatorShortestPath";
      case "greatCircle":
        return "greatCircle";
      case "automatic": {
        const useGreatCircle =
          this.presentationStateResolver.isSphericalSurfaceActive(startState) || Math.min(startState.zoom, targetState.zoom) < this.settings.presentation.automaticTransitionStartZoom;
        return useGreatCircle ? "greatCircle" : "mercatorShortestPath";
      }
    }
  }

  /** As `ImmersiveMapCameraRuntime.setCameraState`: every state is followed by the presentation's constraints. */
  private setCameraState(cameraState: ImmersiveMapCameraState): void {
    this.renderCamera.setCameraState(cameraState);
    this.applyCurrentConstraints();
  }

  private setCameraPosition(position: ImmersiveMapCameraPosition): void {
    this.renderCamera.setCameraPosition(position);
    this.applyCurrentConstraints();
  }

  private applyCurrentConstraints(): void {
    this.renderCamera.applyConstraints(this.presentationStateResolver.cameraConstraints(this.renderCamera.currentCameraState()));
  }
}

function makeSegments(shots: readonly ImmersiveMapCameraTourShot[], initialPosition: ImmersiveMapCameraPosition, settings: CameraPresentationSettings): Segment[] {
  let previousPosition = initialPosition;
  let cursor = 0;
  const segments: Segment[] = [];
  for (const shot of shots) {
    const startState = ImmersiveMapCameraState.fromPosition(previousPosition, settings.camera);
    const targetState = ImmersiveMapCameraState.fromPosition(shot.position, settings.camera);
    const duration = Number.isFinite(shot.options.duration) ? shot.options.duration : CameraFlightMath.minimumDuration;
    const flightDuration = CameraFlightMath.hasMeaningfulDelta(startState, targetState) && duration > 0 ? duration : 0;
    const holdDuration = Math.max(0, shot.holdAfter);
    segments.push({ shot, startTime: cursor, flightDuration, holdDuration, flightEndTime: cursor + flightDuration, endTime: cursor + flightDuration + holdDuration });
    cursor += flightDuration + holdDuration;
    previousPosition = shot.position;
  }
  return segments;
}
