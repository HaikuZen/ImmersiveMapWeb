// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the planner parts of the Swift `DebugOverlayShadowGroupTests`:
// the map size ladder, the graphs' axes and the titles.

import { describe, expect, test } from "vitest";
import { defaultShadowSettings } from "../../configuration/scene-settings.ts";
import { zoomCurve, zoomCurveStops } from "../../configuration/zoom-curve.ts";
import { ShadowFrameStateResolver } from "../../shadows/shadow-frame-state-resolver.ts";
import { defaultHillshade } from "../../style/theme.ts";
import { DebugOverlayShadowSettingsPlanner as Planner } from "./debug-overlay-shadow-settings-planner.ts";

const contains = (range: { readonly lowerBound: number; readonly upperBound: number }, value: number) =>
  value >= range.lowerBound && value <= range.upperBound;

describe("the shadow group's map size ladder", () => {
  test("every ladder step selects itself", () => {
    Planner.mapResolutions.forEach((resolution, index) => {
      expect(Planner.mapResolutionIndex(resolution)).toBe(index);
      expect(Planner.mapResolution(index)).toBe(resolution);
    });
  });

  /** A resolution set in code need not be on the ladder: the segment then shows the nearest step rather than the first. */
  test("a resolution off the ladder selects the nearest step", () => {
    expect(Planner.mapResolutionIndex(1000)).toBe(1);
    expect(Planner.mapResolutionIndex(1900)).toBe(2);
    expect(Planner.mapResolutionIndex(100)).toBe(0);
    expect(Planner.mapResolutionIndex(99_999)).toBe(3);
  });

  test("a segment off the ladder falls back to the first step", () => {
    expect(Planner.mapResolution(-1)).toBe(512);
    expect(Planner.mapResolution(99)).toBe(512);
  });

  /** A step outside what the resolver accepts would silently clamp, and the panel would show a size the map is not rendering at. */
  test("the ladder stays inside the resolver's range", () => {
    const [lower, upper] = ShadowFrameStateResolver.mapResolutionRange;
    for (const resolution of Planner.mapResolutions) {
      expect(resolution).toBeGreaterThanOrEqual(lower);
      expect(resolution).toBeLessThanOrEqual(upper);
    }
  });

  /** Opening the panel must not itself change the map. */
  test("the shipping default is on the ladder", () => {
    const resolution = defaultShadowSettings.mapResolution;
    expect(Planner.mapResolution(Planner.mapResolutionIndex(resolution))).toBe(resolution);
  });

  test("the segment edit sets the ladder's step", () => {
    expect(Planner.withMapResolutionIndex(defaultShadowSettings, 1).mapResolution).toBe(1024);
  });
});

describe("the shadow group's graphs", () => {
  /** The coverage graphs span the resolver's whole clamp, in decades and geometric between the stops, and every shipping stop is on them. */
  test("the coverage graphs span the resolver's clamp and the defaults", () => {
    const axes = Planner.coverageAxes;
    const [lower, upper] = ShadowFrameStateResolver.coverageMetersRange;
    expect(axes.valueRange).toEqual({ lowerBound: lower, upperBound: upper });
    expect(axes.isLogarithmic).toBe(true);
    expect(axes.interpolation).toBe("geometric");
    for (const stop of [...zoomCurveStops(defaultShadowSettings.nearCoverageMeters), ...zoomCurveStops(defaultShadowSettings.farCoverageMeters)]) {
      expect(contains(axes.valueRange, stop.value)).toBe(true);
      expect(contains(axes.zoomRange, stop.zoom)).toBe(true);
    }
    for (const stop of zoomCurveStops(defaultShadowSettings.strength)) {
      expect(contains(Planner.strengthAxes.valueRange, stop.value)).toBe(true);
    }
    for (const stop of [...zoomCurveStops(defaultHillshade.fadeStartMeters), ...zoomCurveStops(defaultHillshade.fadeEndMeters)]) {
      expect(contains(Planner.hillshadeFadeAxes.valueRange, stop.value)).toBe(true);
    }
  });

  /** The titles read the curves at the camera's zoom as the resolver does: between the stops geometrically. */
  test("the graph titles read the curves at the camera's zoom", () => {
    const shadows = defaultShadowSettings;
    expect(Planner.strengthTitle(shadows.strength, 15)).toBe("Strength 0.22");
    expect(Planner.strengthTitle(shadows.strength, 12)).toBe("Strength 0 (off at this zoom)");
    expect(Planner.nearCoverageTitle(shadows.nearCoverageMeters, 14)).toBe("Near coverage 6 km");
    expect(Planner.nearCoverageTitle(shadows.nearCoverageMeters, 15)).toBe("Near coverage 3 km");
    expect(Planner.farCoverageTitle(shadows.farCoverageMeters, shadows.nearCoverageMeters, 18)).toBe("Far coverage 1.5 km");
    expect(Planner.farCoverageTitle(zoomCurve(3500), zoomCurve(3000), 16)).toBe("Far coverage 3.5 km (off, under the near)");
    expect(Planner.hillshadeFadeStartTitle(defaultHillshade.fadeStartMeters, 14)).toBe("Hillshade from 4 km");
    expect(Planner.hillshadeFadeEndTitle(defaultHillshade.fadeEndMeters, 18)).toBe("Hillshade to 500 m");
  });

  test("a graph's edit replaces its curve alone", () => {
    const edited = Planner.withCurve(defaultShadowSettings, "nearCoverageMeters", zoomCurve(800));
    expect(edited.nearCoverageMeters).toEqual(zoomCurve(800));
    expect(edited.farCoverageMeters).toBe(defaultShadowSettings.farCoverageMeters);
  });
});

describe("the shadow group's sliders", () => {
  /** A slider must reach every value the setting accepts and none it does not, or it reports a number the renderer is not using. */
  test("the sliders match the resolver's clamps and hold the defaults", () => {
    expect(Planner.normalOffsetRange).toEqual({
      lowerBound: ShadowFrameStateResolver.normalOffsetTexelsRange[0],
      upperBound: ShadowFrameStateResolver.normalOffsetTexelsRange[1],
    });
    expect(contains(Planner.normalOffsetRange, defaultShadowSettings.normalOffsetTexels)).toBe(true);
    expect(Planner.casterHeightRange).toEqual({
      lowerBound: ShadowFrameStateResolver.maxCasterHeightRange[0],
      upperBound: ShadowFrameStateResolver.maxCasterHeightRange[1],
    });
    expect(contains(Planner.casterHeightRange, defaultShadowSettings.maxCasterHeightMeters)).toBe(true);
    expect(Planner.softnessRange).toEqual({
      lowerBound: ShadowFrameStateResolver.softnessRange[0],
      upperBound: ShadowFrameStateResolver.softnessRange[1],
    });
    expect(contains(Planner.softnessRange, defaultShadowSettings.softness)).toBe(true);
  });

  test("the titles carry the value", () => {
    expect(Planner.normalOffsetTitle(2.5)).toBe("Normal offset 2.5tx");
    expect(Planner.casterHeightTitle(50)).toBe("Caster height 50 m");
    expect(Planner.softnessTitle(1.75)).toBe("Softness 1.75x");
    expect(Planner.azimuthTitle(213.7)).toBe("Sun azimuth 214°");
    expect(Planner.elevationTitle(54.2)).toBe("Sun elevation 54°");
  });

  test("the hillshade's amounts go out to a hundredth, inside 0 to 1", () => {
    expect(Planner.hillshadeAmounts(0.764, 0.333, 1.2)).toEqual({ intensity: 0.76, shadow: 0.33, highlight: 1 });
    expect(Planner.hillshadeIntensityTitle(0.76)).toBe("Hillshade intensity 0.76");
    expect(Planner.hillshadeFadeOfStyle(defaultHillshade)).toEqual({
      startMeters: defaultHillshade.fadeStartMeters,
      endMeters: defaultHillshade.fadeEndMeters,
    });
  });
});
