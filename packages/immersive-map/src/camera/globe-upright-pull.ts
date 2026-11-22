// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GlobeUprightPullSettings } from "../configuration/camera-settings.ts";
import { CameraBearingConstraintResolver, type CameraConstraints } from "./camera-constraint-resolver.ts";
import type { ViewMode } from "./view-mode.ts";

/**
 * How far from upright (north up, looking straight down) the globe's camera
 * may rest at a zoom. Unlike `CameraConstraints` this is not a wall: the
 * camera may be outside it, and `GlobeUprightPull` draws it back.
 */
export interface GlobeUprightWindow {
  readonly maximumAbsoluteBearing: number;
  readonly maximumPitch: number;
}

export function clampedWindowBearing(window: GlobeUprightWindow, bearing: number): number {
  return Math.min(Math.max(bearing, -window.maximumAbsoluteBearing), window.maximumAbsoluteBearing);
}

export interface GlobeUprightPullStep {
  readonly bearing: number;
  readonly pitch: number;
  /** Whether either angle is still outside the window. */
  readonly isPulling: boolean;
}

/**
 * The pull that keeps a zoomed-out globe upright
 * (`CameraSettings.globeUprightPull`): the window it holds the camera to, and
 * the eased step toward that window.
 */
export const GlobeUprightPull = {
  /** An angle this close to the window, in radians, lands on it. */
  snapThreshold: 0.0003,

  /**
   * The window at a zoom, null where nothing is held: with the pull off, on
   * the flat map, and from the upper bound of the zoom range on. It closes
   * linearly from the camera's own limits at the upper bound to north up and
   * the pitch floor at the lower one.
   */
  window(
    zoom: number,
    settings: GlobeUprightPullSettings | null,
    renderSurfaceMode: ViewMode,
    constraints: CameraConstraints,
  ): GlobeUprightWindow | null {
    if (settings === null || renderSurfaceMode !== "spherical" || !(zoom < settings.zoomRange.upperBound)) {
      return null;
    }

    const span = settings.zoomRange.upperBound - settings.zoomRange.lowerBound;
    const progress = span > Number.MIN_VALUE ? Math.min(Math.max((zoom - settings.zoomRange.lowerBound) / span, 0), 1) : 0;
    const bearingCeiling = Math.min(Math.max(constraints.bearing.maximumAbsoluteBearing ?? Math.PI, 0), Math.PI);
    const pitchFloor = constraints.pitch.clampedMinimumPitch;
    const pitchCeiling = constraints.pitch.clampedMaximumPitch;
    return {
      maximumAbsoluteBearing: bearingCeiling * progress,
      maximumPitch: pitchFloor + (pitchCeiling - pitchFloor) * progress,
    };
  },

  /**
   * One frame of the pull: the part of each angle outside the window halves
   * every `halfLife` seconds. An angle inside the window is returned as it
   * came.
   */
  step(bearing: number, pitch: number, window: GlobeUprightWindow, deltaTime: number, halfLife: number): GlobeUprightPullStep {
    const remaining = halfLife > 0 && Number.isFinite(halfLife) ? Math.exp((-Math.log(2.0) * Math.max(deltaTime, 0)) / halfLife) : 0;

    const normalizedBearing = CameraBearingConstraintResolver.normalized(bearing);
    const bearingEdge = clampedWindowBearing(window, normalizedBearing);
    const bearingStep = pulled(normalizedBearing, bearingEdge, remaining);
    const pitchEdge = Math.min(pitch, window.maximumPitch);
    const pitchStep = pulled(pitch, pitchEdge, remaining);

    return {
      bearing: normalizedBearing === bearingEdge ? bearing : bearingStep.value,
      pitch: pitchStep.value,
      isPulling: bearingStep.isOutside || pitchStep.isOutside,
    };
  },
} as const;

function pulled(value: number, edge: number, remaining: number): { value: number; isOutside: boolean } {
  const excess = (value - edge) * remaining;
  if (!(Math.abs(excess) > GlobeUprightPull.snapThreshold)) {
    return { value: edge, isOutside: false };
  }
  return { value: edge + excess, isOutside: true };
}
