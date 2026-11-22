// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraConstraints } from "../../camera/camera-constraint-resolver.ts";
import type { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";

/** A closed range of an angle, in radians, `minimum <= maximum` whatever order it was given in. */
export class ImmersiveMapCameraAngleLimits {
  readonly minimum: number;
  readonly maximum: number;

  constructor(minimum: number, maximum: number) {
    this.minimum = Math.min(minimum, maximum);
    this.maximum = Math.max(minimum, maximum);
  }

  clamped(value: number): number {
    return Math.min(Math.max(value, this.minimum), this.maximum);
  }
}

/** The bearing range, symmetric around north, at most the half turn. */
export class ImmersiveMapCameraBearingLimits {
  readonly maximumAbsoluteBearing: number;

  constructor(maximumAbsoluteBearing: number) {
    this.maximumAbsoluteBearing = Math.min(Math.max(maximumAbsoluteBearing, 0), Math.PI);
  }

  get minimum(): number {
    return -this.maximumAbsoluteBearing;
  }

  get maximum(): number {
    return this.maximumAbsoluteBearing;
  }

  /** The bearing normalized to [-pi, pi) and clamped into the range. */
  clamped(bearing: number): number {
    return Math.min(Math.max(normalizedBearing(bearing), this.minimum), this.maximum);
  }
}

/** The bearing brought into [-pi, pi). */
export function normalizedBearing(bearing: number): number {
  const twoPi = Math.PI * 2;
  let normalized = (bearing + Math.PI) % twoPi;
  if (normalized < 0) {
    normalized += twoPi;
  }
  return normalized - Math.PI;
}

/**
 * The camera as an app's own controls read it: the position, and the ranges
 * its bearing and pitch may take where it is now, which a custom control
 * panel sizes its sliders from.
 */
export class ImmersiveMapCameraSnapshot {
  readonly position: ImmersiveMapCameraPosition;
  readonly bearingLimits: ImmersiveMapCameraBearingLimits;
  readonly pitchLimits: ImmersiveMapCameraAngleLimits;
  readonly isSphericalSurfaceActive: boolean;
  /**
   * The zoom the map is planned by: the zoom of the tiles, the rings and the
   * relief's thresholds. It moves only with a zoom set on purpose, a gesture
   * or a position, while `position.zoom`, the camera's own, also follows the
   * ground relief under the point the camera looks at through a drag. Equal
   * to it off the relief.
   */
  readonly planningZoom: number;

  constructor(
    position: ImmersiveMapCameraPosition,
    bearingLimits: ImmersiveMapCameraBearingLimits,
    pitchLimits: ImmersiveMapCameraAngleLimits,
    isSphericalSurfaceActive: boolean,
    planningZoom: number | null = null,
  ) {
    this.position = position;
    this.bearingLimits = bearingLimits;
    this.pitchLimits = pitchLimits;
    this.isSphericalSurfaceActive = isSphericalSurfaceActive;
    this.planningZoom = planningZoom ?? position.zoom;
  }

  /** `position` with its bearing and pitch clamped into the limits. */
  clampedPosition(position: ImmersiveMapCameraPosition): ImmersiveMapCameraPosition {
    return {
      latitudeDegrees: position.latitudeDegrees,
      longitudeDegrees: position.longitudeDegrees,
      zoom: position.zoom,
      bearing: this.bearingLimits.clamped(position.bearing),
      pitch: this.pitchLimits.clamped(position.pitch),
    };
  }

  /** Field by field, as Swift's synthesized `==`. */
  equals(other: ImmersiveMapCameraSnapshot): boolean {
    const a = this.position;
    const b = other.position;
    return (
      a.latitudeDegrees === b.latitudeDegrees &&
      a.longitudeDegrees === b.longitudeDegrees &&
      a.zoom === b.zoom &&
      a.bearing === b.bearing &&
      a.pitch === b.pitch &&
      this.bearingLimits.maximumAbsoluteBearing === other.bearingLimits.maximumAbsoluteBearing &&
      this.pitchLimits.minimum === other.pitchLimits.minimum &&
      this.pitchLimits.maximum === other.pitchLimits.maximum &&
      this.isSphericalSurfaceActive === other.isSphericalSurfaceActive &&
      this.planningZoom === other.planningZoom
    );
  }
}

/** Builds the snapshot of a position under the constraints in force. */
export const ImmersiveMapCameraSnapshotResolver = {
  resolve(
    position: ImmersiveMapCameraPosition,
    constraints: CameraConstraints,
    isSphericalSurfaceActive: boolean,
    planningZoom: number | null = null,
  ): ImmersiveMapCameraSnapshot {
    const bearingLimits = new ImmersiveMapCameraBearingLimits(constraints.bearing.maximumAbsoluteBearing ?? Math.PI);
    const pitchLimits = new ImmersiveMapCameraAngleLimits(constraints.pitch.clampedMinimumPitch, constraints.pitch.clampedMaximumPitch);
    const unclamped = new ImmersiveMapCameraSnapshot(position, bearingLimits, pitchLimits, isSphericalSurfaceActive);
    return new ImmersiveMapCameraSnapshot(unclamped.clampedPosition(position), bearingLimits, pitchLimits, isSphericalSurfaceActive, planningZoom);
  },
} as const;
