// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `ShadowsModifierTests`, `CameraControlZoneSettingsTests`,
// `TransparentSpaceSettingsTests` (the settings parts),
// `ExtrusionRiseModifierTests` (BuildingExtrusionToggleTests.swift), the
// modifier parts of `GroundFogTests` and `RasterTileTests`, and the night
// modifier of `NightThemeTests`.

import { describe, expect, test } from "vitest";
import { defaultMapStyle, nightMapStyle, nightTheme } from "../style/theme.ts";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { fogSettings, nightFogSettings } from "./scene-settings.ts";
import { zoomCurve } from "./zoom-curve.ts";

const settings = ImmersiveMapSettings.default;

describe("the shadows modifier", () => {
  test("a value set in place leaves the others", () => {
    const shadows = settings
      .shadows({ strength: 0.4, nearCoverageMeters: { 14: 5000, 18: 400 } })
      .shadows({ farCoverageMeters: 20_000, maxCasterHeightMeters: 120 }).scene.shadows;
    const defaults = settings.scene.shadows;
    expect(shadows.isEnabled).toBe(true);
    expect(shadows.maxCasterHeightMeters).toBe(120);
    expect(shadows.strength).toEqual(zoomCurve(0.4));
    expect(shadows.nearCoverageMeters).toEqual(zoomCurve({ 14: 5000, 18: 400 }));
    expect(shadows.farCoverageMeters).toEqual(zoomCurve(20_000));
    expect(shadows.mapResolution).toBe(defaults.mapResolution);
    expect(shadows.softness).toBe(defaults.softness);
  });

  test("the switch alone still turns them off", () => {
    const shadows = settings.shadows({ isEnabled: false }).scene.shadows;
    expect(shadows.isEnabled).toBe(false);
    expect(shadows.nearCoverageMeters).toEqual(settings.scene.shadows.nearCoverageMeters);
  });

  test("an option left undefined keeps its value", () => {
    const strength: number | undefined = undefined;
    expect(settings.shadows({ strength }).scene.shadows.strength).toEqual(settings.scene.shadows.strength);
  });
});

describe("the camera control zones", () => {
  test("the zones are on by default", () => {
    expect(settings.camera.controlZones).toEqual({ isPitchZoneEnabled: true, isZoomZoneEnabled: true });
  });

  test("the modifier turns both zones off", () => {
    expect(settings.cameraControlZones({ pitch: false, zoom: false }).camera.controlZones).toEqual({
      isPitchZoneEnabled: false,
      isZoomZoneEnabled: false,
    });
  });

  test("the modifier can keep a single zone", () => {
    expect(settings.cameraControlZones({ pitch: false }).camera.controlZones).toEqual({
      isPitchZoneEnabled: false,
      isZoomZoneEnabled: true,
    });
  });

  test("the zoom range modifier leaves the omitted bound alone", () => {
    const camera = settings.zoomRange({ minimum: 3 }).camera;
    expect(camera.minimumZoom).toBe(3);
    expect(camera.maximumZoom).toBe(settings.camera.maximumZoom);
  });

  test("the pitch range modifier leaves the omitted bound alone", () => {
    const camera = settings.pitchRange({ minimum: 0.2 }).camera;
    expect(camera.minimumPitch).toBe(0.2);
    expect(camera.maximumPitch).toBe(settings.camera.maximumPitch);
  });

  test("the bearing limit modifier sets and clears the cap", () => {
    expect(settings.bearingLimit(Math.PI / 2).camera.maximumAbsoluteBearing).toBe(Math.PI / 2);
    expect(settings.bearingLimit(Math.PI / 2).bearingLimit(null).camera.maximumAbsoluteBearing).toBeNull();
  });

  test("the tilt gesture sensitivity modifier writes the setting", () => {
    expect(settings.tiltGestureSensitivity(-3).camera.tiltGestureSensitivity).toBe(-3);
  });

  /** All of these rewrite the camera settings, so a later one must not silently undo an earlier one. */
  test("the camera modifiers do not overwrite each other", () => {
    const camera = settings
      .cameraControlZones({ pitch: false })
      .zoomRange({ minimum: 4, maximum: 17 })
      .pitchRange({ minimum: 0.1, maximum: 1.2 })
      .bearingLimit(Math.PI / 3)
      .tiltGestureSensitivity(2.5).camera;
    expect(camera.minimumZoom).toBe(4);
    expect(camera.maximumZoom).toBe(17);
    expect(camera.minimumPitch).toBe(0.1);
    expect(camera.maximumPitch).toBe(1.2);
    expect(camera.maximumAbsoluteBearing).toBe(Math.PI / 3);
    expect(camera.tiltGestureSensitivity).toBe(2.5);
    expect(camera.controlZones.isZoomZoneEnabled).toBe(true);
    expect(camera.controlZones.isPitchZoneEnabled).toBe(false);
  });

  test("the globe bearing limit takes its two values or a limit", () => {
    expect(settings.globeBearingLimit(Math.PI / 12, 6).camera.globeBearingLimit).toEqual({
      minimumAbsoluteBearing: Math.PI / 12,
      unlockZoom: 6,
    });
    expect(settings.globeBearingLimit(Math.PI / 12, 6).globeBearingLimit(null).camera.globeBearingLimit).toBeNull();
  });

  test("the camera bounds take the defaults of the pull", () => {
    const bounds = settings.cameraBounds({ southWest: { latitude: 55.57, longitude: 37.36 }, northEast: { latitude: 55.92, longitude: 37.86 } })
      .camera.bounds;
    expect(bounds?.pullZoomRange).toEqual({ lowerBound: 1, upperBound: 2 });
    expect(bounds?.pullCurve).toEqual({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
    expect(bounds?.edgeBehavior).toEqual({ kind: "elastic", maximumStretch: 200, pullHalfLife: 0.35, pullProgression: 2 });
  });
});

describe("the transparent space", () => {
  test("space is opaque by default", () => {
    expect(settings.scene.space.isTransparent).toBe(false);
  });

  test("the modifier sets the flag", () => {
    expect(settings.transparentSpace().scene.space.isTransparent).toBe(true);
    expect(settings.transparentSpace(false).scene.space.isTransparent).toBe(false);
  });
});

describe("the extrusion's rise", () => {
  test("the modifier leaves the other values as configured", () => {
    const extrusion = settings.buildingExtrusion({ buildingsMinimumZoom: 16, riseSeconds: 1 }).buildingExtrusion({ riseSeconds: 0.25 }).scene
      .extrusion;
    expect(extrusion.buildingsMinimumZoom).toBe(16);
    expect(extrusion.riseSeconds).toBe(0.25);
  });

  test("the rise switch", () => {
    const off = settings.buildingExtrusion({ risesFromTheGround: false });
    expect(off.scene.extrusion.riseSeconds).toBe(0);
    expect(off.buildingExtrusion({ risesFromTheGround: true }).scene.extrusion.riseSeconds).toBe(0.6);
    const tuned = settings.buildingExtrusion({ riseSeconds: 1 }).buildingExtrusion({ risesFromTheGround: true });
    expect(tuned.scene.extrusion.riseSeconds).toBe(1);
    expect(settings.buildingExtrusion({ riseSeconds: -1 }).scene.extrusion.riseSeconds).toBe(0);
    expect(settings.buildingExtrusion({ riseSeconds: 0.3, risesFromTheGround: true }).scene.extrusion.riseSeconds).toBe(0.3);
    expect(settings.buildingExtrusion({ riseSeconds: 0.3, risesFromTheGround: false }).scene.extrusion.riseSeconds).toBe(0);
  });
});

describe("the ground fog modifiers", () => {
  test("the modifier leaves the other values as configured", () => {
    const changed = settings.groundFog({ densityPerKilometer: 1.2 });
    expect(changed.scene.groundFog.isEnabled).toBe(true);
    expect(changed.scene.groundFog.densityPerKilometer).toEqual(zoomCurve(1.2));
    expect(changed.scene.groundFog.heightMeters).toEqual(settings.scene.groundFog.heightMeters);
    expect(changed.scene.groundFog.startDistanceMeters).toEqual(settings.scene.groundFog.startDistanceMeters);
    expect(changed.groundFog({ isEnabled: false }).scene.groundFog.isEnabled).toBe(false);
  });

  test("the buildings sink into the fog by default", () => {
    expect(settings.scene.groundFog.veilsBuildings).toBe(true);
    expect(settings.groundFog({ veilsBuildings: false }).scene.groundFog.veilsBuildings).toBe(false);
    expect(settings.groundFog({ veilsBuildings: false }).groundFog({ densityPerKilometer: 2 }).scene.groundFog.veilsBuildings).toBe(false);
  });

  test("the colour is the horizon's by default and the fog's own when given", () => {
    expect(settings.scene.groundFog.color).toBeNull();
    expect(settings.groundFog({ color: [0.9, 0.8, 0.7] }).scene.groundFog.color).toEqual([0.9, 0.8, 0.7]);
  });

  test("the mountain air starts from the one set so far, or from the plain's", () => {
    const tuned = settings.mountainGroundFog({ baseAltitudeMeters: 900 });
    expect(tuned.scene.mountainGroundFog?.baseAltitudeMeters).toBe(900);
    expect(tuned.scene.mountainGroundFog?.heightMeters).toEqual(settings.scene.mountainGroundFog?.heightMeters);
    const fromPlain = settings.mountainGroundFog(null).mountainGroundFog({ heightsFromSeaLevel: false });
    expect(fromPlain.scene.mountainGroundFog).toEqual({ ...settings.scene.groundFog, heightsFromSeaLevel: false });
  });
});

describe("the raster tiles' modifier", () => {
  test("the modifier leaves the other values as configured", () => {
    const changed = settings.tileRasterization({ mipLevelBias: 0.5 });
    expect(changed.tiles.rasterization.mipLevelBias).toBe(0.5);
    expect(changed.tiles.rasterization.maximumAnisotropy).toBe(settings.tiles.rasterization.maximumAnisotropy);
  });
});

describe("the night", () => {
  /** One modifier sets the palette and the air, and takes both back. */
  test("the night modifier sets the palette and the air", () => {
    const night = settings.night();
    expect(night.data.mapStyle).toEqual(nightMapStyle);
    expect(night.data.mapStyle.theme).toEqual(nightTheme);
    expect(night.scene.fog).toEqual(nightFogSettings);
    expect(night.scene.groundFog.color).toBeNull();
    expect(night.scene.fog.skyColor[2]).toBeLessThan(0.2);

    const day = night.night(false);
    expect(day.data.mapStyle).toEqual(defaultMapStyle);
    expect(day.scene.fog).toEqual(fogSettings());
  });

  test("the trees' modifier keeps the count at zero and up", () => {
    expect(settings.trees({ maximumPerTile: -4 }).scene.trees.maximumPerTile).toBe(0);
    expect(settings.trees({ isEnabled: false }).scene.trees.minimumZoom).toBe(14);
  });
});
