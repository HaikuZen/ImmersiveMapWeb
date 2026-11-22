// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlaySettingsExportTests`
// (DebugOverlayShadowGroupTests.swift) and the export test of
// `ImmersiveMapLabelOpacityTests`. The written code is checked by applying
// the same modifiers here and comparing the settings.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { zoomCurve } from "../../configuration/zoom-curve.ts";
import { DebugOverlaySettingsExport as Export } from "./debug-overlay-settings-export.ts";

describe("DebugOverlaySettingsExport", () => {
  test("numbers carry only their decimals", () => {
    expect(Export.number(0.3)).toBe("0.3");
    expect(Export.number(3)).toBe("3");
    expect(Export.number(0.03)).toBe("0.03");
    expect(Export.number(-0.4)).toBe("-0.4");
    expect(Export.number(-0.00001)).toBe("0");
    expect(Export.number(0.1 + 0.2)).toBe("0.3");
  });

  test("a curve is written as its literal", () => {
    expect(Export.curve(zoomCurve(1.7))).toBe("1.7");
    expect(Export.curve(zoomCurve({ 8: 0, 12: 3 }))).toBe("{ 8: 0, 12: 3 }");
    expect(Export.curve(zoomCurve({ 12: 5, 16.5: 0.03 }))).toBe("{ 12: 5, 16.5: 0.03 }");
  });

  test("the ground fog is written with its curves", () => {
    const settings = ImmersiveMapSettings.default.groundFog({ densityPerKilometer: { 12: 0.45, 16: 17 }, startDistanceMeters: 400 });
    const code = Export.typeScriptCode(settings, new Date(0), ["Zoom 12.3"]);
    expect(code).toContain("// Zoom 12.3");
    expect(code).toContain("// 1970-01-01T00:00:00Z");
    expect(code).toContain("export const settings = ImmersiveMapSettings.default");
    expect(code).toContain(".groundFog({ isEnabled: true, densityPerKilometer: { 12: 0.45, 16: 17 }, heightMeters: ");
    expect(code).toContain("startDistanceMeters: 400");
    expect(code).toContain("heightsFromSeaLevel: true, baseAltitudeMeters: 0 })");
    expect(code.trimEnd().endsWith(";")).toBe(true);
    expect(code).not.toContain("http");
  });

  /** The lines are the modifiers' own calls: applied to the default they give the exported groups back. */
  test("the modifiers recreate the exported groups", () => {
    const tuned = ImmersiveMapSettings.default
      .shadows({ strength: { 14: 0, 15.5: 0.4 }, softness: 2, mapResolution: 2048 })
      .fogSettings({ skyColor: [0.1, 0.25, 0.5] })
      .groundFog({ color: [0.8, 0.7, 0.6], heightMeters: { 7: 3000, 16: 200 } })
      .mountainGroundFog(null)
      .sceneLight({ direction: [0.5, -0.25, 0.75] })
      .atmosphereSettings({ intensity: 1.25, thickness: { 2: 1.5, 6: 1 } })
      .globeLight({ subsolarLongitudeDegrees: 30, isEnabled: false })
      .terrainSurroundings({ plainBelowMetres: 120, smoothingHalfLife: 0.75 });
    const lines = Export.modifiers(tuned.scene, tuned.tiles.groundRelief.surroundings);
    expect(lines.map((line) => line.slice(0, line.indexOf("(")))).toEqual([
      ".fogSettings",
      ".groundFog",
      ".mountainGroundFog",
      ".sceneLight",
      ".shadows",
      ".atmosphereSettings",
      ".globeLight",
      ".terrainSurroundings",
    ]);
    const build = new Function("ImmersiveMapSettings", `return ImmersiveMapSettings.default${lines.join("")};`) as (
      type: typeof ImmersiveMapSettings,
    ) => ImmersiveMapSettings;
    const rebuilt = build(ImmersiveMapSettings);
    expect(rebuilt.scene.shadows).toEqual(tuned.scene.shadows);
    expect(rebuilt.scene.fog).toEqual(tuned.scene.fog);
    expect(rebuilt.scene.groundFog).toEqual(tuned.scene.groundFog);
    expect(rebuilt.scene.mountainGroundFog).toBeNull();
    expect(rebuilt.scene.light).toEqual(tuned.scene.light);
    expect(rebuilt.scene.atmosphere).toEqual(tuned.scene.atmosphere);
    expect(rebuilt.scene.globeLight).toEqual(tuned.scene.globeLight);
    expect(rebuilt.tiles.groundRelief.surroundings).toEqual(tuned.tiles.groundRelief.surroundings);
  });

  test("the default mountain air is written whole", () => {
    const code = Export.typeScriptCode(ImmersiveMapSettings.default, new Date(0), []);
    expect(code).toContain(".mountainGroundFog({ isEnabled: true, densityPerKilometer: { 7: 0.02, 12: 0.02, 16: 1.4, 22: 6 }");
    expect(code).toContain("color: null");
  });

  /** The dragged label opacity is written into the style's theme, and nothing of it when the panel has not touched it. */
  test("the export writes the dragged label opacity into the style's theme", () => {
    const opacity = { names: zoomCurve({ 2: 1, 6: 0.5 }), pois: zoomCurve(0.7) };
    const line = Export.labelOpacityModifier(opacity);
    expect(line.startsWith(".edit((s) => void (s.mapStyle.theme.labelOpacity = ")).toBe(true);
    expect(line).toContain("names: zoomCurve({ 2: 1, 6: 0.5 })");
    expect(line).toContain("pois: zoomCurve(0.7)");
    const without = Export.typeScriptCode(ImmersiveMapSettings.default, new Date(0), []);
    expect(without).not.toContain("labelOpacity");
    expect(without).toContain('import { ImmersiveMapSettings } from "@immersive-map/web";');
    const withOpacity = Export.typeScriptCode(ImmersiveMapSettings.default, new Date(0), [], opacity);
    expect(withOpacity).toContain(`${line};`);
    expect(withOpacity).toContain('import { ImmersiveMapSettings, zoomCurve } from "@immersive-map/web";');
  });

  test("the file's name sorts by when it was taken", () => {
    expect(Export.fileName(new Date(2026, 10, 22, 9, 5, 7))).toBe("ImmersiveMapSettings-2026-11-22-090507.ts");
  });
});
