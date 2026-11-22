// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraFlightMath, OverviewFlightProfile } from "../math/camera-flight-math.ts";
import type { Vec2 } from "../math/vec.ts";
import type { CameraFlightAltitudeStyle } from "./immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";

/** The route a flight takes once `automatic` is decided. */
export type ResolvedCameraFlightRouteStyle = "mercatorShortestPath" | "greatCircle";

export interface CameraFlightStep {
  readonly cameraState: ImmersiveMapCameraState;
  readonly didFinish: boolean;
}

interface Flight {
  readonly startState: ImmersiveMapCameraState;
  readonly targetState: ImmersiveMapCameraState;
  readonly duration: number;
  readonly routeStyle: ResolvedCameraFlightRouteStyle;
  /** Null means direct zoom interpolation (`direct` or a degenerate route). */
  readonly overviewProfile: OverviewFlightProfile | null;
  readonly startTime: number;
}

/**
 * Pure interpolation mechanism for camera flights. Holds one active flight
 * and produces camera state steps for a given frame time, in seconds.
 *
 * Ported from the Swift engine's `UI/Camera` with the flight math, which its
 * tests exercise together.
 */
export class CameraFlightAnimator {
  private flight: Flight | null = null;

  get isActive(): boolean {
    return this.flight !== null;
  }

  start(
    startState: ImmersiveMapCameraState,
    targetState: ImmersiveMapCameraState,
    duration: number,
    routeStyle: ResolvedCameraFlightRouteStyle,
    altitudeStyle: CameraFlightAltitudeStyle,
    currentTime: number,
  ): boolean {
    const sanitizedDuration = Math.max(CameraFlightMath.minimumDuration, Number.isFinite(duration) ? duration : 0);
    if (!CameraFlightMath.hasMeaningfulDelta(startState, targetState)) {
      this.cancel();
      return false;
    }
    this.flight = {
      startState,
      targetState,
      duration: sanitizedDuration,
      routeStyle,
      overviewProfile: makeOverviewProfile(startState, targetState, routeStyle, altitudeStyle),
      startTime: currentTime,
    };
    return true;
  }

  advance(currentTime: number): CameraFlightStep | null {
    const flight = this.flight;
    if (flight === null) {
      return null;
    }

    const rawProgress = flight.duration > 0 ? (currentTime - flight.startTime) / flight.duration : 1;
    const clampedProgress = Math.min(Math.max(rawProgress, 0), 1);
    const easedProgress = CameraFlightMath.easeInOutCubic(clampedProgress);
    // The profile couples pan and zoom: near the ground the center barely
    // moves, the camera covers most of the distance at the apex, so the pan
    // follows panProgress.
    const overviewSample = flight.overviewProfile?.sample(easedProgress) ?? null;
    const panProgress = overviewSample?.panProgress ?? easedProgress;
    const start = flight.startState.centerWorldMercator;
    const target = flight.targetState.centerWorldMercator;
    let centerWorldMercator: Vec2;
    switch (flight.routeStyle) {
      case "mercatorShortestPath":
        centerWorldMercator = CameraFlightMath.mercatorCenter(start, target, panProgress);
        break;
      case "greatCircle":
        centerWorldMercator =
          CameraFlightMath.greatCircleCenter(start, target, panProgress) ?? CameraFlightMath.mercatorCenter(start, target, panProgress);
        break;
    }

    const zoom = overviewSample?.zoom ?? flight.startState.zoom + (flight.targetState.zoom - flight.startState.zoom) * easedProgress;
    const bearing = CameraFlightMath.interpolateBearing(flight.startState.bearing, flight.targetState.bearing, easedProgress);
    const pitch = flight.startState.pitch + (flight.targetState.pitch - flight.startState.pitch) * easedProgress;
    const nextState = ImmersiveMapCameraState.make(centerWorldMercator, zoom, bearing, pitch);
    const didFinish = clampedProgress >= 1;
    if (didFinish) {
      this.flight = null;
    }
    return { cameraState: nextState, didFinish };
  }

  cancel(): void {
    this.flight = null;
  }
}

function makeOverviewProfile(
  startState: ImmersiveMapCameraState,
  targetState: ImmersiveMapCameraState,
  routeStyle: ResolvedCameraFlightRouteStyle,
  altitudeStyle: CameraFlightAltitudeStyle,
): OverviewFlightProfile | null {
  if (altitudeStyle !== "overviewFirst") {
    return null;
  }
  const routeDistance =
    routeStyle === "mercatorShortestPath"
      ? CameraFlightMath.mercatorRouteDistance(startState.centerWorldMercator, targetState.centerWorldMercator)
      : CameraFlightMath.greatCircleRouteDistance(startState.centerWorldMercator, targetState.centerWorldMercator);
  return OverviewFlightProfile.make(startState.zoom, targetState.zoom, routeDistance);
}
