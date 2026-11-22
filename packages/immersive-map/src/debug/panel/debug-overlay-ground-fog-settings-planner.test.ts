// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayGroundFogGroupTests`
// (DebugOverlayShadowGroupTests.swift), with the switching between the two
// airs the Swift panel view does.

import { describe, expect, test } from "vitest";
import { defaultGroundFogSettings, groundFogCurveFields } from "../../configuration/scene-settings.ts";
import type { GroundFogCurveField } from "../../configuration/scene-settings.ts";
import { zoomCurve, zoomCurveStops, zoomCurveValue } from "../../configuration/zoom-curve.ts";
import { DebugOverlayGroundFogSettingsPlanner as Planner } from "./debug-overlay-ground-fog-settings-planner.ts";
import type { DebugOverlayAirs } from "./debug-overlay-ground-fog-settings-planner.ts";

const contains = (range: { readonly lowerBound: number; readonly upperBound: number }, value: number) =>
  value >= range.lowerBound && value <= range.upperBound;

describe("the Air group's graphs and titles", () => {
  test("the graphs cover the shipping default", () => {
    for (const field of Object.keys(groundFogCurveFields) as GroundFogCurveField[]) {
      const axes = Planner.axes(field);
      for (const stop of zoomCurveStops(defaultGroundFogSettings[field])) {
        expect(contains(axes.valueRange, stop.value)).toBe(true);
        expect(contains(axes.zoomRange, stop.zoom)).toBe(true);
      }
    }
  });

  test("the titles carry the value at the camera's zoom", () => {
    expect(Planner.densityTitle(zoomCurve(0.45), 12)).toBe("Density 0.45/km");
    expect(Planner.startDistanceTitle(zoomCurve(400), 12)).toBe("From 400 m");
    expect(Planner.startDistanceTitle(zoomCurve({ 12: 3200, 16: 200 }), 13)).toBe("From 1.6 km");
    expect(Planner.heightTitle(zoomCurve({ 13: 4000, 15: 150 }), 16)).toBe("Height 150 m");
    expect(Planner.startSoftnessTitle(zoomCurve(25_000), 12)).toBe("Soft start 25 km");
    expect(Planner.maximumOpacityTitle(zoomCurve({ 18: 1, 19: 0 }), 15)).toBe("Max opacity 1.00");
    expect(Planner.baseAltitudeTitle(1500)).toBe("Full density up to 1.5 km");
    expect(Planner.title("heightMeters", zoomCurve(150), 12)).toBe("Height 150 m");
    expect(Planner.valueText("densityPerKilometer")(17)).toBe("17/km");
    expect(Planner.valueText("maximumOpacity")(0.5)).toBe("0.50");
  });

  /** The mountain air preset replaces the overview's stops and keeps the street zooms' as the app has them. */
  test("the mountain air preset keeps the street zooms", () => {
    const fog = defaultGroundFogSettings;
    const preset = Planner.mountainAirPreset(fog);
    expect(preset.densityPerKilometer).toEqual(zoomCurve({ 7: 0.02, 12: 0.02, 16: 1.4, 22: 6 }));
    expect(preset.startDistanceMeters).toEqual(zoomCurve({ 7: 10, 12: 10, 16: 400, 22: 250 }));
    expect(zoomCurveValue(preset.heightMeters, 10)).toBe(2500);
    expect(preset.baseAltitudeMeters).toBe(1500);
    expect(preset.heightsFromSeaLevel).toBe(true);
    expect(preset.maximumOpacity).toEqual(fog.maximumOpacity);
    expect(contains(Planner.baseAltitudeRange, fog.baseAltitudeMeters)).toBe(true);
  });

  test("the base altitude goes out in steps of 50 m", () => {
    expect(Planner.withBaseAltitude(defaultGroundFogSettings, 1274).baseAltitudeMeters).toBe(1250);
    expect(Planner.withBaseAltitude(defaultGroundFogSettings, 1275).baseAltitudeMeters).toBe(1300);
    expect(Planner.baseAltitudeEnabled({ ...defaultGroundFogSettings, heightsFromSeaLevel: false })).toBe(false);
  });
});

describe("the Air group's two airs", () => {
  const plain = defaultGroundFogSettings;
  const oneAir: DebugOverlayAirs = { plain, mountain: null, editsMountainAir: false };

  test("switching the mountain air on starts it from the plain's and edits it", () => {
    const on = Planner.mountainSwitched(oneAir, true);
    expect(on.target).toBe("mountain");
    expect(on.settings).toEqual(Planner.mountainAirPreset(plain));
    expect(on.airs.editsMountainAir).toBe(true);
    expect(Planner.airChoiceIndex(on.airs)).toBe(1);
    expect(Planner.editedAir(on.airs)).toBe(on.airs.mountain);

    const off = Planner.mountainSwitched(on.airs, false);
    expect(off.settings).toBeNull();
    expect(off.airs.editsMountainAir).toBe(false);
    expect(Planner.airChoiceEnabled(off.airs)).toBe(false);
  });

  test("an edit goes to the air being edited", () => {
    const both = Planner.mountainSwitched(oneAir, true).airs;
    const edited = Planner.publishing(both, Planner.withEnabled(Planner.editedAir(both), false));
    expect(edited.target).toBe("mountain");
    expect(edited.airs.mountain?.isEnabled).toBe(false);
    expect(edited.airs.plain).toBe(plain);

    const plainChosen = Planner.airChosen(both, 0);
    expect(Planner.publishing(plainChosen, plain).target).toBe("plain");
    expect(Planner.airChosen(oneAir, 1).editsMountainAir).toBe(false);
  });

  test("the mountain air switched off elsewhere turns the group back to the plain's", () => {
    const both = Planner.mountainSwitched(oneAir, true).airs;
    expect(Planner.applying(both, plain, null).editsMountainAir).toBe(false);
    expect(Planner.applying(both, plain, both.mountain).editsMountainAir).toBe(true);
  });

  test("the preset goes to the air being edited", () => {
    expect(Planner.presetApplied(oneAir).target).toBe("plain");
    expect(Planner.presetApplied(oneAir).settings).toEqual(Planner.mountainAirPreset(plain));
  });
});
