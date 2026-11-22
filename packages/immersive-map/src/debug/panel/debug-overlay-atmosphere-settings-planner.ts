// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import type { Rgb } from "../../configuration/color.ts";
import type { AtmosphereSettings, FogSettings } from "../../configuration/scene-settings.ts";
import { zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import { formatFixed } from "./debug-overlay-geometry.ts";
import { DebugOverlayZoomCurveAxes } from "./debug-overlay-zoom-curve-editing.ts";

const thicknessRange = closedRange(0.05, 3);
const thicknessAxes = DebugOverlayZoomCurveAxes.of(closedRange(0, 22), thicknessRange);

/**
 * The Sky tab's atmosphere group: its ranges and titles (the Swift
 * `DebugOverlayAtmosphereSettingsPlanner`). The panel edits
 * `AtmosphereSettings` live, and the ranges are the ones the settings
 * document as useful rather than everything they accept.
 */
export const DebugOverlayAtmosphereSettingsPlanner = {
  /** 1 is the designed look, 0 leaves the sphere bare with the layer on. */
  intensityRange: closedRange(0, 2),
  /** Relative to the designed halo width, over the zoom on a graph like the air's curves. The resolver floors it at 0.05. */
  thicknessRange,
  thicknessAxes,
  sunInfluenceRange: closedRange(0, 1),

  intensityTitle(intensity: number): string {
    return `Intensity ${formatFixed(intensity, 2)}`;
  },

  /** The thickness at the camera's zoom, which the graph marks with a line. */
  thicknessTitle(thickness: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return DebugOverlayAtmosphereSettingsPlanner.thicknessText(zoomCurveValue(thickness, cameraZoom, thicknessAxes.interpolation));
  },

  thicknessText(thickness: number): string {
    return `Thickness ${formatFixed(thickness, 2)}x`;
  },

  sunInfluenceTitle(influence: number): string {
    return `Sun influence ${formatFixed(influence, 2)}`;
  },

  /** Off keeps only the limb's feather, so the colour, the sliders and the graph mean nothing then. */
  controlsEnabled(atmosphere: AtmosphereSettings): boolean {
    return atmosphere.isEnabled;
  },

  withEnabled(atmosphere: AtmosphereSettings, isEnabled: boolean): AtmosphereSettings {
    return { ...atmosphere, isEnabled };
  },

  withColor(atmosphere: AtmosphereSettings, color: Rgb): AtmosphereSettings {
    return { ...atmosphere, color };
  },

  withIntensity(atmosphere: AtmosphereSettings, intensity: number): AtmosphereSettings {
    return { ...atmosphere, intensity };
  },

  withThickness(atmosphere: AtmosphereSettings, thickness: ImmersiveMapZoomCurve): AtmosphereSettings {
    return { ...atmosphere, thickness };
  },

  withSunInfluence(atmosphere: AtmosphereSettings, sunInfluence: number): AtmosphereSettings {
    return { ...atmosphere, sunInfluence };
  },
} as const;

/**
 * The Sky tab's Horizon group (`FogSettings`): a switch and two colours,
 * which the Swift panel edits in its view with no planner of its own.
 */
export const DebugOverlaySkySettingsPlanner = {
  groupTitle: "Horizon",
  enabledTitle: "Enabled",
  skyColorTitle: "Sky colour",
  horizonColorTitle: "Horizon colour",

  /** The colours only mean something with the sky on. */
  controlsEnabled(fog: FogSettings): boolean {
    return fog.isEnabled;
  },

  withEnabled(fog: FogSettings, isEnabled: boolean): FogSettings {
    return { ...fog, isEnabled };
  },

  withSkyColor(fog: FogSettings, skyColor: Rgb): FogSettings {
    return { ...fog, skyColor };
  },

  withHorizonColor(fog: FogSettings, horizonColor: Rgb): FogSettings {
    return { ...fog, horizonColor };
  },
} as const;
