// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayAtmosphereGroupTests` and
// `DebugOverlayPanelCategoryTests` (DebugOverlayShadowGroupTests.swift), the
// panel parts of `GlobeLightTests` and `GroundReliefOcclusionTests`, with the
// smaller planners' edits and the panel's number formats.

import { describe, expect, test } from "vitest";
import { defaultModelArchiveSettings, maximumModelDepthBias } from "../../configuration/model-archive-settings.ts";
import { defaultAtmosphereSettings, defaultFogSettings, defaultGlobeLightSettings } from "../../configuration/scene-settings.ts";
import { defaultTileSettings } from "../../configuration/tile-settings.ts";
import { zoomCurve, zoomCurveStops } from "../../configuration/zoom-curve.ts";
import { DebugOverlayHUDContentRequest } from "../../render/debug/debug-overlay-hud-snapshot-store.ts";
import { defaultTerrainOcclusion } from "../../style/theme.ts";
import { DebugOverlayAtmosphereSettingsPlanner, DebugOverlaySkySettingsPlanner } from "./debug-overlay-atmosphere-settings-planner.ts";
import { DebugOverlayColor } from "./debug-overlay-color.ts";
import { DebugOverlayValueText, formatG } from "./debug-overlay-geometry.ts";
import { DebugOverlayGlobeLightSettingsPlanner } from "./debug-overlay-globe-light-settings-planner.ts";
import { DebugOverlayLabelOpacitySettingsPlanner } from "./debug-overlay-label-opacity-settings-planner.ts";
import { DebugOverlayModelArchiveSettingsPlanner } from "./debug-overlay-model-archive-settings-planner.ts";
import { DebugOverlayOcclusionPlanner } from "./debug-overlay-occlusion-planner.ts";
import { DebugOverlayPanelCategory } from "./debug-overlay-panel-category.ts";
import { DebugOverlayTerrainSurroundingsSettingsPlanner } from "./debug-overlay-terrain-surroundings-settings-planner.ts";

const contains = (range: { readonly lowerBound: number; readonly upperBound: number }, value: number) =>
  value >= range.lowerBound && value <= range.upperBound;

describe("DebugOverlayPanelCategory", () => {
  test("all shows every category and a tab only its own", () => {
    for (const category of DebugOverlayPanelCategory.allCases) {
      expect(DebugOverlayPanelCategory.shows("all", category)).toBe(true);
    }
    expect(DebugOverlayPanelCategory.shows("sky", "sky")).toBe(true);
    expect(DebugOverlayPanelCategory.shows("sky", "tiles")).toBe(false);
    expect(DebugOverlayPanelCategory.shows("sky", "air")).toBe(false);
    expect(DebugOverlayPanelCategory.title("air")).toBe("Air");
    expect(DebugOverlayPanelCategory.title("globe")).toBe("Globe");
    expect(DebugOverlayPanelCategory.title("occlusion")).toBe("AO");
    expect(DebugOverlayPanelCategory.shows("occlusion", "occlusion")).toBe(true);
    expect(DebugOverlayPanelCategory.shows("shadows", "occlusion")).toBe(false);
  });

  /** The frame builds only what the tab shows: the settings tabs read nothing of it. */
  test("each tab asks the frame for its own content", () => {
    expect(DebugOverlayPanelCategory.shownContent("all")).toBe(DebugOverlayHUDContentRequest.all);
    expect(DebugOverlayPanelCategory.shownContent("stats")).toBe(DebugOverlayHUDContentRequest.stats);
    expect(DebugOverlayPanelCategory.shownContent("tiles")).toBe(DebugOverlayHUDContentRequest.tiles);
    expect(DebugOverlayPanelCategory.shownContent("relief")).toBe(DebugOverlayHUDContentRequest.relief);
    expect(DebugOverlayPanelCategory.shownContent("occlusion")).toBe(DebugOverlayHUDContentRequest.relief);
    expect(DebugOverlayPanelCategory.shownContent("export")).toBe(DebugOverlayHUDContentRequest.none);
  });
});

describe("the atmosphere and the sky", () => {
  test("the sliders cover the shipping default", () => {
    const atmosphere = defaultAtmosphereSettings;
    expect(contains(DebugOverlayAtmosphereSettingsPlanner.intensityRange, atmosphere.intensity)).toBe(true);
    for (const stop of zoomCurveStops(atmosphere.thickness)) {
      expect(contains(DebugOverlayAtmosphereSettingsPlanner.thicknessAxes.valueRange, stop.value)).toBe(true);
      expect(contains(DebugOverlayAtmosphereSettingsPlanner.thicknessAxes.zoomRange, stop.zoom)).toBe(true);
    }
    expect(contains(DebugOverlayAtmosphereSettingsPlanner.sunInfluenceRange, atmosphere.sunInfluence)).toBe(true);
  });

  test("the titles carry the value", () => {
    expect(DebugOverlayAtmosphereSettingsPlanner.intensityTitle(1)).toBe("Intensity 1.00");
    expect(DebugOverlayAtmosphereSettingsPlanner.thicknessTitle(zoomCurve(2), 3)).toBe("Thickness 2.00x");
    expect(DebugOverlayAtmosphereSettingsPlanner.thicknessTitle(zoomCurve({ 2: 3, 6: 1 }), 4)).toBe("Thickness 2.00x");
    expect(DebugOverlayAtmosphereSettingsPlanner.sunInfluenceTitle(0.6)).toBe("Sun influence 0.60");
  });

  test("the sky's controls edit the colours and mean nothing with it off", () => {
    const sky = DebugOverlaySkySettingsPlanner.withSkyColor(defaultFogSettings, [0.1, 0.2, 0.3]);
    expect(sky.skyColor).toEqual([0.1, 0.2, 0.3]);
    expect(DebugOverlaySkySettingsPlanner.controlsEnabled(DebugOverlaySkySettingsPlanner.withEnabled(sky, false))).toBe(false);
  });
});

describe("the globe light", () => {
  test("the titles, the range and the slider edits", () => {
    const planner = DebugOverlayGlobeLightSettingsPlanner;
    expect(planner.strengthTitle(zoomCurve({ 2: 0.8, 6: 0.2 }), 4)).toBe("Strength 0.50");
    expect(planner.softnessTitle(0.25)).toBe("Terminator softness 0.25");
    expect(planner.subsolarLatitudeTitle(10)).toBe("Sun latitude 10°");
    expect(planner.subsolarLongitudeTitle(-15)).toBe("Sun longitude -15°");
    expect(contains(planner.softnessRange, defaultGlobeLightSettings.terminatorSoftness)).toBe(true);
    expect(planner.withSubsolarLatitude(defaultGlobeLightSettings, 10.6).subsolarLatitudeDegrees).toBe(11);
    expect(planner.withTerminatorSoftness(defaultGlobeLightSettings, 0.256).terminatorSoftness).toBe(0.26);
  });
});

describe("the ambient occlusion", () => {
  test("the radius slider round-trips and the pickers snap to their steps", () => {
    for (const metres of [100, 250, 1000, 3000, 20_000]) {
      const back = DebugOverlayOcclusionPlanner.radiusMetres(DebugOverlayOcclusionPlanner.sliderValue(metres));
      expect(Math.abs(back - metres)).toBeLessThanOrEqual(metres * 0.01);
    }
    expect(DebugOverlayOcclusionPlanner.directionsIndex(8)).toBe(1);
    expect(DebugOverlayOcclusionPlanner.directionsIndex(7)).toBe(1);
    expect(DebugOverlayOcclusionPlanner.resolutionIndex(512)).toBe(3);
    expect(DebugOverlayOcclusionPlanner.radiusTitle(2500)).toBe("Radius 2.5 km");
    expect(DebugOverlayOcclusionPlanner.radiusTitle(400)).toBe("Radius 400 m");
    expect(DebugOverlayOcclusionPlanner.strengthTitle(0.6)).toBe("Strength 0.60");
  });

  test("the controls read as one occlusion", () => {
    const occlusion = DebugOverlayOcclusionPlanner.occlusion(defaultTerrainOcclusion, {
      isEnabled: false,
      strengthSlider: 0.456,
      radiusSlider: 1,
      directionsSegment: 9,
      resolutionSegment: 0,
    });
    expect(occlusion).toEqual({ isEnabled: false, strength: 0.46, radiusMeters: 20_000, directions: 32, resolution: 64 });
  });
});

describe("the smaller planners", () => {
  test("the surroundings go out in round metres and hundredths of a second", () => {
    const planner = DebugOverlayTerrainSurroundingsSettingsPlanner;
    const settings = planner.settings(defaultTileSettings.groundRelief.surroundings, {
      sampleRadiusMetres: 4000.4,
      plainBelowMetres: 149.6,
      mountainsAboveMetres: 600,
      smoothingHalfLife: 0.456,
    });
    expect(settings).toEqual({ sampleRadiusMetres: 4000, plainBelowMetres: 150, mountainsAboveMetres: 600, smoothingHalfLife: 0.46 });
    expect(planner.smoothingHalfLifeTitle(0.5)).toBe("Smoothing 0.50 s");
    expect(planner.sampleRadiusTitle(4000)).toBe("Radius 4000 m");
    const surroundings = defaultTileSettings.groundRelief.surroundings;
    expect(contains(planner.sampleRadiusRange, surroundings.sampleRadiusMetres)).toBe(true);
    expect(contains(planner.plainBelowRange, surroundings.plainBelowMetres)).toBe(true);
    expect(contains(planner.mountainsAboveRange, surroundings.mountainsAboveMetres)).toBe(true);
    expect(contains(planner.smoothingHalfLifeRange, surroundings.smoothingHalfLife)).toBe(true);
  });

  test("the labels' opacity and the models' depth bias", () => {
    expect(DebugOverlayLabelOpacitySettingsPlanner.namesTitle(zoomCurve({ 2: 1, 6: 0.5 }), 4)).toBe("Names opacity 0.75");
    expect(DebugOverlayLabelOpacitySettingsPlanner.poisTitle(zoomCurve(1), 12)).toBe("POI opacity 1.00");
    const planner = DebugOverlayModelArchiveSettingsPlanner;
    expect(planner.depthBiasAxes.valueRange.upperBound).toBe(maximumModelDepthBias);
    expect(planner.depthBiasTitle(defaultModelArchiveSettings.depthBias, 14)).toBe("Depth bias 0.050");
    expect(planner.depthBias({ ...defaultModelArchiveSettings, archiveURL: null })).toBeUndefined();
    expect(planner.edited(zoomCurve(1))).toEqual(zoomCurve(maximumModelDepthBias));
  });

  test("the panel's number formats", () => {
    expect(DebugOverlayValueText.meters(999.4)).toBe("999 m");
    expect(DebugOverlayValueText.meters(1000)).toBe("1 km");
    expect(DebugOverlayValueText.meters(1540)).toBe("1.5 km");
    expect(formatG(0.45)).toBe("0.45");
    expect(formatG(17)).toBe("17");
    expect(formatG(1_234_567)).toBe("1.23457e+06");
    expect(formatG(0.00001)).toBe("1e-05");
    expect(DebugOverlayColor.hex([1, 0.5, 0])).toBe("#ff8000");
    expect(DebugOverlayColor.rgb("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(DebugOverlayColor.rgb("orange")).toBeUndefined();
  });
});
