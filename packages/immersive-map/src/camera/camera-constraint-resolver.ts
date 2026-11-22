// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type CameraSettings, type GlobeBearingLimit, maximumReachablePitch } from "../configuration/camera-settings.ts";
import type { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import type { ViewMode } from "./view-mode.ts";

/** The walls the camera's angles are held within at a state and a surface. */
export interface CameraConstraints {
  readonly bearing: CameraBearingConstraint;
  readonly pitch: CameraPitchConstraint;
}

export class CameraBearingConstraint {
  /** The cap on the bearing's distance from north, null for none. */
  readonly maximumAbsoluteBearing: number | null;

  constructor(maximumAbsoluteBearing: number | null) {
    this.maximumAbsoluteBearing = maximumAbsoluteBearing;
  }

  apply(bearing: number): number {
    const normalizedBearing = CameraBearingConstraintResolver.normalized(bearing);
    if (this.maximumAbsoluteBearing === null) {
      return normalizedBearing;
    }
    const clampedLimit = Math.min(Math.max(this.maximumAbsoluteBearing, 0), Math.PI);
    return Math.min(Math.max(normalizedBearing, -clampedLimit), clampedLimit);
  }
}

export class CameraPitchConstraint {
  readonly minimumPitch: number;
  readonly maximumPitch: number;

  constructor(minimumPitch: number, maximumPitch: number) {
    this.minimumPitch = minimumPitch;
    this.maximumPitch = maximumPitch;
  }

  get clampedMaximumPitch(): number {
    return Math.max(this.maximumPitch, 0);
  }

  /**
   * The floor never rises above the ceiling, so an inverted range collapses
   * to the ceiling instead of deadlocking the camera.
   */
  get clampedMinimumPitch(): number {
    return Math.min(Math.max(this.minimumPitch, 0), this.clampedMaximumPitch);
  }

  apply(pitch: number): number {
    return Math.min(Math.max(pitch, this.clampedMinimumPitch), this.clampedMaximumPitch);
  }
}

export const CameraConstraintResolver = {
  resolve(cameraState: ImmersiveMapCameraState, cameraSettings: CameraSettings, renderSurfaceMode: ViewMode): CameraConstraints {
    return {
      bearing: CameraBearingConstraintResolver.resolve(cameraState, cameraSettings, renderSurfaceMode),
      pitch: CameraPitchConstraintResolver.resolve(cameraState, cameraSettings),
    };
  },
} as const;

export const CameraBearingConstraintResolver = {
  resolve(cameraState: ImmersiveMapCameraState, cameraSettings: CameraSettings, renderSurfaceMode: ViewMode): CameraBearingConstraint {
    const globeBearingLimit = cameraSettings.globeBearingLimit;
    if (renderSurfaceMode !== "spherical" || globeBearingLimit === null) {
      return new CameraBearingConstraint(cameraSettings.maximumAbsoluteBearing);
    }
    return new CameraBearingConstraint(
      CameraBearingConstraintResolver.globeMaximumAbsoluteBearing(cameraState.zoom, globeBearingLimit, cameraSettings.maximumAbsoluteBearing),
    );
  },

  globeMaximumAbsoluteBearing(zoom: number, limit: GlobeBearingLimit, maximumAbsoluteBearing: number | null): number {
    // The configured cap is the widest the globe's bearing window opens. A
    // cap below the window's floor collapses the window to the cap.
    const ceiling = Math.min(Math.max(maximumAbsoluteBearing ?? Math.PI, 0), Math.PI);
    const minimumBearing = Math.min(Math.max(limit.minimumAbsoluteBearing, 0), ceiling);
    const unlockZoom = Math.max(limit.unlockZoom, 0);
    if (!(unlockZoom > Number.MIN_VALUE)) {
      return ceiling;
    }
    const progress = Math.min(Math.max(zoom / unlockZoom, 0), 1);
    return minimumBearing + (ceiling - minimumBearing) * progress;
  },

  /** The bearing brought into [-pi, pi). */
  normalized(bearing: number): number {
    const twoPi = Math.PI * 2;
    let normalized = (bearing + Math.PI) % twoPi;
    if (normalized < 0) {
      normalized += twoPi;
    }
    return normalized - Math.PI;
  },
} as const;

export const CameraPitchConstraintResolver = {
  /**
   * The same ceiling on both surfaces: the configured maximum plus the
   * high-zoom extensions, so a whole-planet view can tilt as far as a street
   * view.
   */
  resolve(cameraState: ImmersiveMapCameraState, cameraSettings: CameraSettings): CameraPitchConstraint {
    return new CameraPitchConstraint(cameraSettings.minimumPitch, maximumReachablePitch(cameraSettings, cameraState.zoom));
  },
} as const;
