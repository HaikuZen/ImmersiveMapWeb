// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlaySettingsOverrideTests`
// (DebugOverlayShadowGroupTests.swift) and the override part of
// `GlobeLightTests`, with the Air group's reset of the Swift runtime.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import {
  atmosphereSettings,
  fogSettings,
  globeLightSettings,
  groundFogSettings,
  shadowSettings,
} from "../../configuration/scene-settings.ts";
import { zoomCurve } from "../../configuration/zoom-curve.ts";
import { DebugOverlaySettingsOverride } from "./debug-overlay-settings-override.ts";
import { DebugOverlaySunAngles } from "./debug-overlay-sun-angles.ts";

function settingsWithDebugPanel(isEnabled: boolean): ImmersiveMapSettings {
  return ImmersiveMapSettings.default.debugPanel(isEnabled);
}

describe("DebugOverlaySettingsOverride", () => {
  test("an empty override changes nothing", () => {
    const settings = settingsWithDebugPanel(true);
    expect(DebugOverlaySettingsOverride.applied(DebugOverlaySettingsOverride.empty, settings)).toBe(settings);
  });

  /** The app may hand the map its own settings again at any time, and the drag must hold over them. */
  test("the override survives the app resending its own settings", () => {
    const override: DebugOverlaySettingsOverride = {
      shadows: shadowSettings({ strength: 0.71, nearCoverageMeters: 800 }),
      sunDirection: DebugOverlaySunAngles.direction(30, 20),
    };
    const resent = settingsWithDebugPanel(true);
    const applied = DebugOverlaySettingsOverride.applied(override, resent);
    expect(applied.scene.shadows.strength).toEqual(zoomCurve(0.71));
    expect(applied.scene.shadows.nearCoverageMeters).toEqual(zoomCurve(800));
    expect(DebugOverlaySunAngles.angles(applied.scene.light.direction).azimuthDegrees).toBeCloseTo(30, 3);
    expect(applied.tiles).toBe(resent.tiles);
    expect(applied.camera).toBe(resent.camera);
    expect(applied.scene.atmosphere).toBe(resent.scene.atmosphere);
    expect(applied.scene.fog).toBe(resent.scene.fog);
  });

  test("the atmosphere's override rides on top like the others", () => {
    const dragged = atmosphereSettings({ intensity: 1.6, thickness: 0.5 });
    const override: DebugOverlaySettingsOverride = { atmosphere: dragged };
    const resent = settingsWithDebugPanel(true);
    const applied = DebugOverlaySettingsOverride.applied(override, resent);
    expect(applied.scene.atmosphere).toEqual(dragged);
    expect(applied.scene.fog).toBe(resent.scene.fog);
    expect(applied.scene.shadows).toBe(resent.scene.shadows);
    expect(DebugOverlaySettingsOverride.isEmpty(override)).toBe(false);
  });

  test("the sky's override rides on top like the shadows'", () => {
    const dragged = fogSettings({ horizonColor: [0.9, 0.8, 0.7], skyColor: [0.1, 0.2, 0.9] });
    const resent = settingsWithDebugPanel(true);
    const applied = DebugOverlaySettingsOverride.applied({ fog: dragged }, resent);
    expect(applied.scene.fog).toEqual(dragged);
    expect(applied.scene.shadows).toBe(resent.scene.shadows);
    expect(applied.scene.light).toBe(resent.scene.light);
  });

  test("one group overridden leaves the others alone", () => {
    const settings = settingsWithDebugPanel(true);
    const applied = DebugOverlaySettingsOverride.applied({ sunDirection: DebugOverlaySunAngles.direction(90, 45) }, settings);
    expect(applied.scene.shadows).toBe(settings.scene.shadows);
    expect(applied.scene.light.direction).not.toEqual(settings.scene.light.direction);
  });

  /** With the panel off the app is back in charge, whatever was dragged while it was open. */
  test("the override does not apply with the debug panel off", () => {
    const settings = settingsWithDebugPanel(false);
    const override: DebugOverlaySettingsOverride = { shadows: shadowSettings({ isEnabled: false }) };
    expect(DebugOverlaySettingsOverride.applied(override, settings)).toBe(settings);
    expect(DebugOverlaySettingsOverride.retained(override, settings)).toBe(DebugOverlaySettingsOverride.empty);
    expect(DebugOverlaySettingsOverride.retained(override, settingsWithDebugPanel(true))).toBe(override);
  });

  test("the globe light, the airs, the surroundings and the depth bias ride on top", () => {
    const settings = settingsWithDebugPanel(true);
    const applied = DebugOverlaySettingsOverride.applied(
      {
        globeLight: globeLightSettings({ isEnabled: false }),
        mountainGroundFog: null,
        groundFog: groundFogSettings({ baseAltitudeMeters: 300 }),
        terrainSurroundings: { ...settings.tiles.groundRelief.surroundings, plainBelowMetres: 99 },
        modelDepthBias: zoomCurve({ 14: 0.5 }),
      },
      settings,
    );
    expect(applied.scene.globeLight.isEnabled).toBe(false);
    expect(applied.scene.mountainGroundFog).toBeNull();
    expect(applied.scene.groundFog.baseAltitudeMeters).toBe(300);
    expect(applied.tiles.groundRelief.surroundings.plainBelowMetres).toBe(99);
    expect(applied.tiles.groundRelief.isEnabled).toBe(settings.tiles.groundRelief.isEnabled);
    expect(applied.data.modelArchive.depthBias).toEqual(zoomCurve({ 14: 0.25 }));
  });

  /** The reset puts the app's own airs back, known from the settings the app sent rather than the panel's requests. */
  test("the air's reset brings the app's airs back", () => {
    const app = ImmersiveMapSettings.default.debugPanel().groundFog({ heightMeters: 90 });
    const known = DebugOverlaySettingsOverride.appGroundFog(undefined, DebugOverlaySettingsOverride.empty, app);
    expect(known?.groundFog).toBe(app.scene.groundFog);

    const dragged = groundFogSettings({ heightMeters: 400 });
    const override: DebugOverlaySettingsOverride = { groundFog: dragged, mountainGroundFog: null };
    const panelRequest = DebugOverlaySettingsOverride.applied(override, app);
    expect(DebugOverlaySettingsOverride.appGroundFog(known, override, panelRequest)).toBe(known);

    const reset = DebugOverlaySettingsOverride.resettingGroundFog(override, panelRequest, known);
    expect(reset.override.groundFog).toBeUndefined();
    expect(reset.override.mountainGroundFog).toBeUndefined();
    expect(reset.settings.scene.groundFog).toEqual(app.scene.groundFog);
    expect(reset.settings.scene.mountainGroundFog).toEqual(app.scene.mountainGroundFog);
  });
});
