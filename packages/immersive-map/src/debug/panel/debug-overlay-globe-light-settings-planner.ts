// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import type { Rgb } from "../../configuration/color.ts";
import type { GlobeLightSettings } from "../../configuration/scene-settings.ts";
import { zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import { formatFixed, swiftRounded } from "./debug-overlay-geometry.ts";
import { DebugOverlayZoomCurveAxes } from "./debug-overlay-zoom-curve-editing.ts";

const strengthAxes = DebugOverlayZoomCurveAxes.of(closedRange(0, 22), closedRange(0, 1));

/**
 * The Globe tab: the sun on the globe's graph axes, ranges and titles (the
 * Swift `DebugOverlayGlobeLightSettingsPlanner`). The panel edits
 * `GlobeLightSettings` live.
 */
export const DebugOverlayGlobeLightSettingsPlanner = {
  /** The strength over the zoom, 0 to 1, on a graph like the air's. */
  strengthAxes,
  /** The terminator's softness in the cosine of the sun's angle: a hard line at the bottom, a half globe of dusk at the top. */
  softnessRange: closedRange(0.01, 1),
  /** Where the sun stands overhead. */
  subsolarLatitudeRange: closedRange(-90, 90),
  subsolarLongitudeRange: closedRange(-180, 180),

  strengthTitle(strength: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return DebugOverlayGlobeLightSettingsPlanner.strengthText(zoomCurveValue(strength, cameraZoom, strengthAxes.interpolation));
  },

  strengthText(strength: number): string {
    return `Strength ${formatFixed(strength, 2)}`;
  },

  softnessTitle(softness: number): string {
    return `Terminator softness ${formatFixed(softness, 2)}`;
  },

  subsolarLatitudeTitle(degrees: number): string {
    return `Sun latitude ${formatFixed(degrees, 0)}°`;
  },

  subsolarLongitudeTitle(degrees: number): string {
    return `Sun longitude ${formatFixed(degrees, 0)}°`;
  },

  /** Every control below the switch means something only with the light on. */
  controlsEnabled(light: GlobeLightSettings): boolean {
    return light.isEnabled;
  },

  withEnabled(light: GlobeLightSettings, isEnabled: boolean): GlobeLightSettings {
    return { ...light, isEnabled };
  },

  /** The latitude slider, to a whole degree. */
  withSubsolarLatitude(light: GlobeLightSettings, sliderValue: number): GlobeLightSettings {
    return { ...light, subsolarLatitudeDegrees: swiftRounded(sliderValue) };
  },

  /** The longitude slider, to a whole degree. */
  withSubsolarLongitude(light: GlobeLightSettings, sliderValue: number): GlobeLightSettings {
    return { ...light, subsolarLongitudeDegrees: swiftRounded(sliderValue) };
  },

  withStrength(light: GlobeLightSettings, strength: ImmersiveMapZoomCurve): GlobeLightSettings {
    return { ...light, strength };
  },

  /** The softness slider, to a hundredth. */
  withTerminatorSoftness(light: GlobeLightSettings, sliderValue: number): GlobeLightSettings {
    return { ...light, terminatorSoftness: swiftRounded(sliderValue * 100) / 100 };
  },

  withNightColor(light: GlobeLightSettings, nightColor: Rgb): GlobeLightSettings {
    return { ...light, nightColor };
  },
} as const;
