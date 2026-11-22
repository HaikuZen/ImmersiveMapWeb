// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import type { ImmersiveMapTerrainOcclusion } from "../../style/theme.ts";
import { clampTo, formatFixed, swiftRounded } from "./debug-overlay-geometry.ts";

const radiusRangeMetres = closedRange(100, 20_000);
const directionsOptions: readonly number[] = Object.freeze([4, 8, 16, 32]);
const resolutionOptions: readonly number[] = Object.freeze([64, 128, 256, 512]);

function nearestIndex(options: readonly number[], value: number): number {
  const exact = options.indexOf(value);
  if (exact >= 0) return exact;
  let nearest = 0;
  options.forEach((option, index) => {
    if (Math.abs(option - value) < Math.abs(options[nearest]! - value)) nearest = index;
  });
  return nearest;
}

/**
 * The arithmetic behind the AO tab (`ImmersiveMapTerrainOcclusion`, the Swift
 * `DebugOverlayOcclusionPlanner`): the radius slider runs 0 to 1 and
 * geometrically from 100 m to 20 km, so a hill's folds and a wide valley are
 * both a short drag away, and the directions and the resolution come as the
 * steps of a picker.
 */
export const DebugOverlayOcclusionPlanner = {
  radiusRangeMetres,
  directionsOptions,
  resolutionOptions,
  /** The strength slider's range, and the radius slider's, which `radiusMetres` reads. */
  strengthRange: closedRange(0, 1),
  sliderRange: closedRange(0, 1),
  groupTitle: "Ambient occlusion",
  enabledTitle: "Enabled",
  directionsTitle: "Directions",
  resolutionTitle: "Resolution",
  debugViewTitle: "Show AO only",

  /** The slider's 0...1 for a radius in metres, geometric over the range. */
  sliderValue(radiusMetres: number): number {
    const clamped = clampTo(radiusMetres, radiusRangeMetres.lowerBound, radiusRangeMetres.upperBound);
    return Math.log(clamped / radiusRangeMetres.lowerBound) / Math.log(radiusRangeMetres.upperBound / radiusRangeMetres.lowerBound);
  },

  /** The radius in metres for a slider's 0...1, rounded to three digits. */
  radiusMetres(sliderValue: number): number {
    const value = radiusRangeMetres.lowerBound * Math.pow(radiusRangeMetres.upperBound / radiusRangeMetres.lowerBound, clampTo(sliderValue, 0, 1));
    const magnitude = Math.pow(10, Math.floor(Math.log10(value) - 2));
    return swiftRounded(value / magnitude) * magnitude;
  },

  /** The segment of a direction count, the nearest step for one off the picker. */
  directionsIndex(directions: number): number {
    return nearestIndex(directionsOptions, directions);
  },

  /** The segment of a resolution, the nearest step for one off the picker. */
  resolutionIndex(resolution: number): number {
    return nearestIndex(resolutionOptions, resolution);
  },

  strengthTitle(strength: number): string {
    return `Strength ${formatFixed(strength, 2)}`;
  },

  radiusTitle(radiusMetres: number): string {
    return radiusMetres >= 1000 ? `Radius ${formatFixed(radiusMetres / 1000, 1)} km` : `Radius ${formatFixed(radiusMetres, 0)} m`;
  },

  /** The sliders and the pickers mean something only with the occlusion on. */
  controlsEnabled(occlusion: ImmersiveMapTerrainOcclusion): boolean {
    return occlusion.isEnabled;
  },

  /**
   * The controls read as one, an edit of any of them sending the whole: the
   * switch, the strength to a hundredth, the radius from its slider, and the
   * two pickers' segments held to their steps.
   */
  occlusion(
    current: ImmersiveMapTerrainOcclusion,
    controls: {
      readonly isEnabled: boolean;
      readonly strengthSlider: number;
      readonly radiusSlider: number;
      readonly directionsSegment: number;
      readonly resolutionSegment: number;
    },
  ): ImmersiveMapTerrainOcclusion {
    const directions = directionsOptions[clampTo(controls.directionsSegment, 0, directionsOptions.length - 1)] ?? current.directions;
    const resolution = resolutionOptions[clampTo(controls.resolutionSegment, 0, resolutionOptions.length - 1)] ?? current.resolution;
    return {
      ...current,
      isEnabled: controls.isEnabled,
      strength: swiftRounded(controls.strengthSlider * 100) / 100,
      radiusMeters: DebugOverlayOcclusionPlanner.radiusMetres(controls.radiusSlider),
      directions,
      resolution,
    };
  },
} as const;
