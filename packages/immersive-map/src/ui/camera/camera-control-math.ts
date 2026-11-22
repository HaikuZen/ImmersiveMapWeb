// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { ImmersiveMapCameraSnapshot } from "./immersive-map-camera-snapshot.ts";

/** A closed range of degrees, `lowerBound...upperBound`, as a slider of the camera panel spans it. */
export interface CameraControlDegreesRange {
  readonly lowerBound: number;
  readonly upperBound: number;
}

/** The diameter of a slider's thumb, in CSS pixels. */
const sliderThumbSize = 22;

function normalizedDegrees(degrees: number): number {
  // `%` truncates toward zero, as Swift's `truncatingRemainder` does.
  let value = degrees % 360;
  if (value > 180) {
    value -= 360;
  } else if (value < -180) {
    value += 360;
  }
  return value;
}

function clampedDegrees(degrees: number, range: CameraControlDegreesRange): number {
  return Math.min(Math.max(degrees, range.lowerBound), range.upperBound);
}

function degreesFromRadians(radians: number): number {
  return normalizedDegrees((radians * 180) / Math.PI);
}

/**
 * The pure arithmetic of the camera control panel (Swift `CameraControlMath`
 * and the panel's own decisions): angle conversions, the readout, the
 * slider ranges a snapshot allows, the bearing cap and the slider geometry.
 * The panel's DOM part only calls into it.
 */
export const CameraControlMath = {
  /** The diameter of a slider's thumb, in CSS pixels. */
  sliderThumbSize,

  /** Degrees brought into -180...180 by whole turns. */
  normalizedDegrees,

  /** Radians as normalized degrees. */
  degreesFromRadians,

  /** Degrees, normalized first, as radians. */
  radiansFromDegrees(degrees: number): number {
    return (normalizedDegrees(degrees) * Math.PI) / 180;
  },

  /** The live readout, "N deg", rounded half away from zero as Swift's `rounded()`. */
  formattedDegrees(degrees: number): string {
    const rounded = Math.sign(degrees) * Math.round(Math.abs(degrees));
    return `${rounded === 0 ? 0 : rounded} deg`;
  },

  /** `degrees` held inside `range`. */
  clampedDegrees,

  /**
   * The bearing slider's range, in degrees, from the snapshot's limits. A
   * full circle spans -180...179, so the two ends of the slider are not the
   * same heading.
   */
  bearingRangeDegrees(snapshot: ImmersiveMapCameraSnapshot): CameraControlDegreesRange {
    const minimum = degreesFromRadians(snapshot.bearingLimits.minimum);
    const maximum = degreesFromRadians(snapshot.bearingLimits.maximum);
    if (minimum <= -180 && maximum >= 180) {
      return { lowerBound: -180, upperBound: 179 };
    }
    return { lowerBound: minimum, upperBound: maximum };
  },

  /** The pitch slider's range, in degrees, from the snapshot's limits. */
  pitchRangeDegrees(snapshot: ImmersiveMapCameraSnapshot): CameraControlDegreesRange {
    return {
      lowerBound: (snapshot.pitchLimits.minimum * 180) / Math.PI,
      upperBound: (snapshot.pitchLimits.maximum * 180) / Math.PI,
    };
  },

  /**
   * A requested bearing held to the range. Inside it the value is normalized.
   * A value past a cap saturates at that cap in the direction of travel:
   * normalizing it first would carry it across the forbidden arc and clamp
   * it to the opposite edge, turning one +15 press at the cap into a command
   * to the other side of the compass.
   */
  clampedBearingDegrees(degrees: number, range: CameraControlDegreesRange): number {
    const normalized = normalizedDegrees(degrees);
    if (normalized < range.lowerBound || normalized > range.upperBound) {
      return clampedDegrees(degrees, range);
    }
    return normalized;
  },

  /** Where `value` sits along the slider's track, from 0 at the lower bound to 1 at the upper one. */
  sliderProgress(value: number, range: CameraControlDegreesRange): number {
    const { lowerBound, upperBound } = range;
    if (!(upperBound > lowerBound)) {
      return 0;
    }
    return (clampedDegrees(value, range) - lowerBound) / (upperBound - lowerBound);
  },

  /**
   * The slider's value under a pointer at `locationX`, in CSS pixels from
   * the slider's leading edge, for a slider `sliderWidth` wide. The thumb's
   * centre travels the width less one thumb, so either end of the range sits
   * with the thumb wholly inside the slider.
   */
  sliderValue(locationX: number, sliderWidth: number, range: CameraControlDegreesRange): number {
    const trackWidth = Math.max(1, sliderWidth - sliderThumbSize);
    const rawProgress = Math.min(Math.max(0, locationX - sliderThumbSize / 2), trackWidth) / trackWidth;
    const rawValue = range.lowerBound + (range.upperBound - range.lowerBound) * rawProgress;
    return clampedDegrees(rawValue, range);
  },

  /** `position` with the bearing and the pitch given in degrees, the bearing normalized. */
  positionWithCameraAngles(position: ImmersiveMapCameraPosition, bearingDegrees: number, pitchDegrees: number): ImmersiveMapCameraPosition {
    return {
      latitudeDegrees: position.latitudeDegrees,
      longitudeDegrees: position.longitudeDegrees,
      zoom: position.zoom,
      bearing: (normalizedDegrees(bearingDegrees) * Math.PI) / 180,
      pitch: (pitchDegrees * Math.PI) / 180,
    };
  },
} as const;
