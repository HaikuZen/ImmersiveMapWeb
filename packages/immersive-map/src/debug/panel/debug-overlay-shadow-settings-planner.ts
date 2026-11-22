// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { Vector3 } from "../../configuration/color.ts";
import { defaultShadowSettings, shadowStrength } from "../../configuration/scene-settings.ts";
import type { ShadowSettings } from "../../configuration/scene-settings.ts";
import { zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import { ShadowFrameStateResolver } from "../../shadows/shadow-frame-state-resolver.ts";
import type { ImmersiveMapHillshade } from "../../style/theme.ts";
import { GroundReliefHillshade } from "../../tile/relief/frame/ground-relief-hillshade.ts";
import type { GroundReliefHillshadeAmounts, GroundReliefHillshadeFade } from "../../tile/relief/frame/ground-relief-hillshade.ts";
import { DebugOverlayValueText, clampTo, formatFixed, swiftRounded } from "./debug-overlay-geometry.ts";
import { DebugOverlaySunAngles } from "./debug-overlay-sun-angles.ts";
import { DebugOverlayZoomCurveAxes } from "./debug-overlay-zoom-curve-editing.ts";

/** The shadow curves the panel edits on graphs, each a field of `ShadowSettings`. */
export type DebugOverlayShadowCurveField = "strength" | "nearCoverageMeters" | "farCoverageMeters";

/** The hillshade's fade curves the panel edits on graphs, each a field of `GroundReliefHillshadeFade`. */
export type DebugOverlayHillshadeFadeField = "startMeters" | "endMeters";

const zoomRange = closedRange(0, 22);
const mapResolutions: readonly number[] = Object.freeze([512, 1024, 2048, 4096]);
const tupleRange = (range: readonly [number, number]): ClosedRange => closedRange(range[0], range[1]);
const roundedToHundredths = (value: number): number => swiftRounded(value * 100) / 100;

/**
 * The Shadows and Light tabs' values and their titles (the Swift
 * `DebugOverlayShadowSettingsPlanner`).
 *
 * The panel edits `ShadowSettings` live, and the hillshade's fade and amounts
 * over the style's. The strength, the two coverages and the fade are curves
 * over the zoom, each edited on a graph of its own
 * (`DebugOverlayZoomCurveGraph`): the zoom across, the value up, the title
 * carrying the value at the camera's zoom, which the graph marks with a
 * line. The lengths are drawn in decades and run geometrically between
 * their stops, as the resolver reads them, so 50 m and 500 km are both on
 * one axis. The slider ranges are the ones useful to drag through, the
 * resolver's own clamps where it has one, so a slider never reports a value
 * the renderer is not using. The map size is a ladder of powers of two,
 * the only sizes worth comparing.
 */
export const DebugOverlayShadowSettingsPlanner = {
  mapResolutions,
  mapResolutionTitles: Object.freeze(["512", "1K", "2K", "4K"]) as readonly string[],
  /** The zooms every graph spans: the whole range a camera reaches, so a value the same at every zoom (one stop at zoom 0) is on it too. */
  zoomRange,
  /** How dark the shadows are, 0 to 1, by the zoom: the shadows' zoom is where the curve leaves zero. */
  strengthAxes: DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(0, 1)),
  /**
   * Metres on the ground, the resolver's whole clamp: the floor is far below
   * anything worth shipping, since winding the window right down is how the
   * texel grid itself is looked at. Under a window of one camera distance
   * the window's edge shows as a circle, which is expected there.
   */
  coverageAxes: DebugOverlayZoomCurveAxes.of(zoomRange, tupleRange(ShadowFrameStateResolver.coverageMetersRange), {
    isLogarithmic: true,
    interpolation: "geometric",
  }),
  /** Metres from the eye the hillshade fades over, the street to the whole of a range seen from the relief's first zoom. */
  hillshadeFadeAxes: DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(10, 1_000_000), {
    isLogarithmic: true,
    interpolation: "geometric",
  }),
  /** The resolver's own clamp on the caster-height limit. */
  casterHeightRange: tupleRange(ShadowFrameStateResolver.maxCasterHeightRange),
  normalOffsetRange: tupleRange(ShadowFrameStateResolver.normalOffsetTexelsRange),
  /** The resolver's own clamp on the tent's tap spread. */
  softnessRange: tupleRange(ShadowFrameStateResolver.softnessRange),
  azimuthRange: closedRange(0, 360),
  /**
   * The resolver drops shadows below a light elevation of about 3 degrees
   * (`minimumLightDirectionZ`), so the slider stops well above it: a slider
   * whose bottom end silently turns the feature off reads as a bug.
   */
  elevationRange: closedRange(5, 85),
  /** The hillshade's three amounts, each 0 to 1. */
  hillshadeAmountRange: closedRange(0, 1),

  /** The index of the ladder step nearest the resolution, so a value set in code still selects a segment. */
  mapResolutionIndex(resolution: number): number {
    const exact = mapResolutions.indexOf(resolution);
    if (exact >= 0) return exact;
    let nearest = 0;
    mapResolutions.forEach((step, index) => {
      if (Math.abs(step - resolution) < Math.abs(mapResolutions[nearest]! - resolution)) nearest = index;
    });
    return nearest;
  },

  /** The resolution of a segment, the first step for an index off the ladder. */
  mapResolution(index: number): number {
    return mapResolutions[index] ?? mapResolutions[0]!;
  },

  /** The strength at the camera's zoom, and that the shadows are off there when it is nothing. */
  strengthTitle(strength: ImmersiveMapZoomCurve, cameraZoom: number): string {
    const value = shadowStrength({ ...defaultShadowSettings, strength }, cameraZoom);
    return value > 0 ? `Strength ${formatFixed(value, 2)}` : "Strength 0 (off at this zoom)";
  },

  nearCoverageTitle(coverage: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Near coverage ${DebugOverlayShadowSettingsPlanner.metersText(DebugOverlayShadowSettingsPlanner.coverageMeters(coverage, cameraZoom))}`;
  },

  /**
   * The far coverage's title at the camera's zoom, or that the far window is
   * off there because it does not reach past the near one
   * (`ShadowFrameStateResolver.farWindowReaches`).
   */
  farCoverageTitle(farCoverage: ImmersiveMapZoomCurve, nearCoverage: ImmersiveMapZoomCurve, cameraZoom: number): string {
    const planner = DebugOverlayShadowSettingsPlanner;
    const far = planner.coverageMeters(farCoverage, cameraZoom);
    const near = planner.coverageMeters(nearCoverage, cameraZoom);
    return ShadowFrameStateResolver.farWindowReaches(far, near)
      ? `Far coverage ${planner.metersText(far)}`
      : `Far coverage ${planner.metersText(far)} (off, under the near)`;
  },

  hillshadeFadeStartTitle(start: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Hillshade from ${DebugOverlayShadowSettingsPlanner.metersText(zoomCurveValue(start, cameraZoom, "geometric"))}`;
  },

  hillshadeFadeEndTitle(end: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Hillshade to ${DebugOverlayShadowSettingsPlanner.metersText(zoomCurveValue(end, cameraZoom, "geometric"))}`;
  },

  /** A coverage at the camera's zoom as the resolver clamps it, in metres. */
  coverageMeters(coverage: ImmersiveMapZoomCurve, cameraZoom: number): number {
    const [lower, upper] = ShadowFrameStateResolver.coverageMetersRange;
    const meters = zoomCurveValue(coverage, cameraZoom, "geometric");
    return Number.isFinite(meters) ? clampTo(meters, lower, upper) : lower;
  },

  /** A length as the graphs print it (`DebugOverlayValueText.meters`), the coverage graphs' and the fade graphs' value text. */
  metersText(meters: number): string {
    return DebugOverlayValueText.meters(meters);
  },

  /** The strength graph's value text: two decimals. */
  strengthText(strength: number): string {
    return formatFixed(strength, 2);
  },

  casterHeightTitle(meters: number): string {
    return `Caster height ${formatFixed(meters, 0)} m`;
  },

  normalOffsetTitle(texels: number): string {
    return `Normal offset ${formatFixed(texels, 1)}tx`;
  },

  softnessTitle(softness: number): string {
    return `Softness ${formatFixed(softness, 2)}x`;
  },

  azimuthTitle(degrees: number): string {
    return `Sun azimuth ${formatFixed(degrees, 0)}°`;
  },

  elevationTitle(degrees: number): string {
    return `Sun elevation ${formatFixed(degrees, 0)}°`;
  },

  /** Whether a control below the switch means anything: the map size and the three sliders only do with shadows on. The light and the graphs stay live. */
  controlsEnabled(shadows: ShadowSettings): boolean {
    return shadows.isEnabled;
  },

  // The edits the controls make. Each takes the group as the panel shows it
  // and returns it with the control's value, to send whole.

  /** The "Enabled" switch. */
  withEnabled(shadows: ShadowSettings, isEnabled: boolean): ShadowSettings {
    return { ...shadows, isEnabled };
  },

  /** The "Map px" segments. */
  withMapResolutionIndex(shadows: ShadowSettings, index: number): ShadowSettings {
    return { ...shadows, mapResolution: DebugOverlayShadowSettingsPlanner.mapResolution(index) };
  },

  /** A graph's edited curve. */
  withCurve(shadows: ShadowSettings, field: DebugOverlayShadowCurveField, curve: ImmersiveMapZoomCurve): ShadowSettings {
    return { ...shadows, [field]: curve };
  },

  /** The normal offset slider, its value as dragged. */
  withNormalOffset(shadows: ShadowSettings, texels: number): ShadowSettings {
    return { ...shadows, normalOffsetTexels: texels };
  },

  /** The caster height slider, its value as dragged. */
  withCasterHeight(shadows: ShadowSettings, meters: number): ShadowSettings {
    return { ...shadows, maxCasterHeightMeters: meters };
  },

  /** The softness slider, its value as dragged. */
  withSoftness(shadows: ShadowSettings, softness: number): ShadowSettings {
    return { ...shadows, softness };
  },

  /** The sun dragged on the dial, the side view or a slider: the light's new direction (`SceneLightSettings.direction`). */
  sunDirection(azimuthDegrees: number, elevationDegrees: number): Vector3 {
    return DebugOverlaySunAngles.direction(azimuthDegrees, elevationDegrees);
  },

  /** The hillshade's fade as a style states it, before the panel drags it. */
  hillshadeFadeOfStyle(style: ImmersiveMapHillshade): GroundReliefHillshadeFade {
    return { startMeters: style.fadeStartMeters, endMeters: style.fadeEndMeters };
  },

  /** A fade graph's edited curve. */
  withHillshadeFadeCurve(
    fade: GroundReliefHillshadeFade,
    field: DebugOverlayHillshadeFadeField,
    curve: ImmersiveMapZoomCurve,
  ): GroundReliefHillshadeFade {
    return { ...fade, [field]: curve };
  },

  /** The three amount sliders read as one, each to a hundredth: a drag of any of them sends them all. */
  hillshadeAmounts(intensity: number, shadow: number, highlight: number): GroundReliefHillshadeAmounts {
    return GroundReliefHillshade.amounts(roundedToHundredths(intensity), roundedToHundredths(shadow), roundedToHundredths(highlight));
  },

  hillshadeIntensityTitle(intensity: number): string {
    return `Hillshade intensity ${formatFixed(intensity, 2)}`;
  },

  hillshadeShadowTitle(shadow: number): string {
    return `Slope shadow ${formatFixed(shadow, 2)}`;
  },

  hillshadeHighlightTitle(highlight: number): string {
    return `Slope highlight ${formatFixed(highlight, 2)}`;
  },

  /** The switch of the mountains' shadows (`GroundReliefSettings.castsShadows`). */
  reliefShadowsTitle: "Mountain shadows",
} as const;
