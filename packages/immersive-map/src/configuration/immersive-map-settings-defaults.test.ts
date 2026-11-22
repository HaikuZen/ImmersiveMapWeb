// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `ImmersiveMapSettingsDefaultsTests`, `AtmosphereSettingsTests`,
// the settings parts of `GlobeLightTests`, `GlobeUprightPullTests`,
// `GroundReliefTests`, `CameraZoomRangeTests`, `CameraPitchRangeTests`,
// `TileLabelDecisionsTests` (the label language), `AirHandoverTests`
// (HorizonFrameResolverTests.swift) and `ImmersiveMapNeedsTileTests` (the
// parse ceiling).

import { describe, expect, test } from "vitest";
import { cameraSettings, clampPitch, clampZoom, globeUprightPull } from "./camera-settings.ts";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { LabelLanguage } from "./label-settings.ts";
import { airHandover, presentationSettings } from "./presentation-settings.ts";
import { atmosphereSettings, defaultGlobeLightSettings, mountainAir } from "./scene-settings.ts";
import { ImmersiveMapTerrainSource } from "./terrain-source.ts";
import { groundFlatteningGrid, groundReliefSettings, resolvedGroundFlatteningFromTileZoom, resolvedMaximumZoomLevel } from "./tile-settings.ts";
import { zoomCurve, zoomCurveValue } from "./zoom-curve.ts";

const settings = ImmersiveMapSettings.default;

/** The default map laid flat, as `ImmersiveMapSettings.defaultWithoutRelief` of the Swift tests. */
const defaultWithoutRelief = settings.groundRelief({ isEnabled: false });

describe("ImmersiveMapSettings defaults", () => {
  test("the default label language is English", () => {
    expect(settings.data.labels.language).toEqual(LabelLanguage.english);
  });

  test("the default labels are enabled", () => {
    expect(settings.data.labels.isEnabled).toBe(true);
    expect(settings.labels({ isEnabled: false }).data.labels.isEnabled).toBe(false);
  });

  test("the default scene light matches the legacy hard-coded direction", () => {
    expect(settings.scene.light.direction).toEqual([-0.4, -0.6, 1.0]);
  });

  /** The air over the mountains is on by default: the mountain air made of the default plain air. */
  test("the default mountain air is on", () => {
    const scene = settings.scene;
    expect(scene.mountainGroundFog).toEqual(mountainAir(scene.groundFog));
    expect(scene.mountainGroundFog?.isEnabled).toBe(true);
    expect(scene.mountainGroundFog?.baseAltitudeMeters).toBe(1500);
    expect(settings.mountainGroundFog(null).scene.mountainGroundFog).toBeNull();
  });

  test("the default shadows are enabled", () => {
    const shadows = settings.scene.shadows;
    expect(shadows.isEnabled).toBe(true);
    expect(shadows.strength).toEqual(zoomCurve({ 14: 0, 15: 0.22 }));
    expect(shadows.mapResolution).toBe(4096);
    expect(shadows.nearCoverageMeters).toEqual(zoomCurve({ 12: 24_000, 14: 6000, 16: 1500, 18: 500 }));
    expect(shadows.farCoverageMeters).toEqual(zoomCurve({ 12: 96_000, 14: 24_000, 16: 6000, 18: 1500 }));
    expect(shadows.normalOffsetTexels).toBe(2.5);
    expect(shadows.maxCasterHeightMeters).toBe(500);
    expect(shadows.softness).toBe(1.5);
  });

  /** The default shadow is soft and cool, tinted toward the sky rather than toward grey. */
  test("the default shadow tint is cool", () => {
    const [x, y, z] = settings.scene.shadows.tint;
    expect(x).toBeLessThan(y);
    expect(y).toBeLessThan(z);
    expect(z).toBe(1);
  });

  test("the atmosphere's defaults are the shipped ones", () => {
    const atmosphere = atmosphereSettings();
    expect(atmosphere.isEnabled).toBe(true);
    expect(atmosphere.color).toEqual([0.008, 0.18, 0.482]);
    expect(atmosphere.intensity).toBe(1.2);
    expect(atmosphere.thickness).toEqual(zoomCurve({ 2: 3, 6: 0.25 }));
    expect(zoomCurveValue(atmosphere.thickness, 0)).toBe(3);
    expect(zoomCurveValue(atmosphere.thickness, 7)).toBe(0.25);
    expect(atmosphere.sunInfluence).toBe(0.69);
    expect(settings.scene.atmosphere).toEqual(atmosphere);
  });

  test("the atmosphere's modifiers write through", () => {
    const custom = atmosphereSettings({ isEnabled: true, color: [1, 0.5, 0.2], intensity: 0.4, thickness: 1.5, sunInfluence: 0 });
    expect(settings.atmosphereSettings(custom).scene.atmosphere).toEqual(custom);
    expect(settings.atmosphere({ isEnabled: false }).scene.atmosphere.isEnabled).toBe(false);
    expect(settings.atmosphere({ isEnabled: false }).atmosphere().scene.atmosphere.isEnabled).toBe(true);
  });

  test("the globe light's defaults", () => {
    const light = defaultGlobeLightSettings;
    expect(light.isEnabled).toBe(true);
    expect(light.subsolarLatitudeDegrees).toBe(10);
    expect(light.subsolarLongitudeDegrees).toBe(-15);
    expect(light.strength).toEqual(zoomCurve({ 0: 0.6, 1: 0 }));
    expect(light.terminatorSoftness).toBe(0.25);
    expect(light.nightColor).toEqual([0.05, 0.08, 0.18]);
    expect(settings.scene.globeLight).toEqual(light);
    expect(settings.globeLight({ strength: 1, nightColor: [0, 0, 0] }).scene.globeLight.strength).toEqual(zoomCurve(1));
    expect(settings.globeLight({ isEnabled: false }).scene.globeLight.isEnabled).toBe(false);
  });

  test("the upright pull is on by default", () => {
    expect(settings.camera.globeUprightPull).toEqual(globeUprightPull());
    expect(settings.globeUprightPull(null).camera.globeUprightPull).toBeNull();
    expect(settings.globeUprightPull({ halfLife: 0.3 }).camera.globeUprightPull).toEqual({
      zoomRange: { lowerBound: 3, upperBound: 6 },
      halfLife: 0.3,
    });
  });

  test("the parse ceiling comes from the settings", () => {
    expect(settings.tiles.parsing.maximumConcurrentParses).toBe(4);
    expect(settings.tileParsing({ maximumConcurrentParses: 2 }).tiles.parsing.maximumConcurrentParses).toBe(2);
    expect(settings.tileParsing({ maximumConcurrentParses: 0 }).tiles.parsing.maximumConcurrentParses).toBe(1);
    expect(settings.tileParsing().tiles.parsing.maximumConcurrentParses).toBe(4);
  });
});

describe("the ground relief's settings", () => {
  test("the relief is off by default", () => {
    expect(settings.tiles.groundRelief.isEnabled).toBe(false);
    expect(settings.groundRelief({ isEnabled: true }).tiles.groundRelief.isEnabled).toBe(true);
    const relief = defaultWithoutRelief.groundRelief({ isEnabled: true, exaggeration: 3 }).tiles.groundRelief;
    expect(relief.isEnabled).toBe(true);
    expect(relief.exaggeration).toBe(3);
    expect(relief.source).toEqual(ImmersiveMapTerrainSource.mapterhorn);
  });

  /** The relief and the flattening start at one zoom: the tile zoom of the relief's appear zoom. */
  test("the relief flattens from the zoom it appears at", () => {
    let value = defaultWithoutRelief;
    expect(resolvedGroundFlatteningFromTileZoom(value.tiles)).toBe(15);
    value = value.groundRelief({ isEnabled: true });
    expect(value.tiles.groundRelief.appearZoom).toBe(10);
    expect(resolvedGroundFlatteningFromTileZoom(value.tiles)).toBe(10);
    value = value.groundRelief({ appearZoom: 11.6 });
    expect(resolvedGroundFlatteningFromTileZoom(value.tiles)).toBe(11);
    value = value.groundRelief({ appearZoom: 30 });
    expect(resolvedGroundFlatteningFromTileZoom(value.tiles)).toBe(resolvedMaximumZoomLevel(value.tiles.coverage));
    value = value.groundFlattening({ isEnabled: false }).groundRelief({ appearZoom: 10 });
    expect(resolvedGroundFlatteningFromTileZoom(value.tiles)).toBe(10);
    value = value.groundRelief({ isEnabled: false });
    expect(resolvedGroundFlatteningFromTileZoom(value.tiles)).toBeNull();
  });

  test("a zoom may take a grid of its own", () => {
    const flattening = settings.groundFlattening({ grid: 32, gridByTileZoom: { 12: 128, 13: 96 } }).tiles.groundFlattening;
    expect(groundFlatteningGrid(flattening, 12)).toBe(128);
    expect(groundFlatteningGrid(flattening, 13)).toBe(96);
    expect(groundFlatteningGrid(flattening, 15)).toBe(32);
    const defaults = settings.tiles.groundFlattening;
    expect(defaults.gridByTileZoom).toEqual({ 0: 64, 1: 64, 2: 32, 3: 32, 9: 128, 10: 128, 11: 128, 12: 128, 13: 64, 14: 32 });
    expect(groundFlatteningGrid(defaults, 15)).toBe(16);
    expect(groundFlatteningGrid(defaults, 8)).toBe(16);
  });

  test("the camera's map and the cache are the settings", () => {
    const relief = groundReliefSettings();
    expect(relief.cameraTerrainZoom).toBe(10);
    expect(settings.groundRelief({ cameraTerrainZoom: -3 }).tiles.groundRelief.cameraTerrainZoom).toBe(0);
    expect(relief.displacementMaximumZoom).toBe(10);
    expect(settings.groundRelief({ displacementMaximumZoom: 13 }).tiles.groundRelief.displacementMaximumZoom).toBe(13);
    expect(relief.releasedCacheBytes).toBe(50 * 2 ** 20);
    expect(settings.groundRelief({ releasedCacheBytes: -1 }).tiles.groundRelief.releasedCacheBytes).toBe(0);
  });

  test("the surroundings' values are held to their floors", () => {
    const surroundings = settings.terrainSurroundings({ sampleRadiusMetres: 0, plainBelowMetres: -1, smoothingHalfLife: -2 }).tiles
      .groundRelief.surroundings;
    expect(surroundings.sampleRadiusMetres).toBe(1);
    expect(surroundings.plainBelowMetres).toBe(0);
    expect(surroundings.smoothingHalfLife).toBe(0);
    expect(surroundings.mountainsAboveMetres).toBe(600);
  });
});

describe("the camera's ranges", () => {
  const camera = (options: { minimumZoom?: number; maximumZoom?: number; minimumPitch?: number; maximumPitch?: number }) =>
    cameraSettings(options);

  test("the default range keeps the whole globe and the top-down view reachable", () => {
    expect(settings.camera.minimumZoom).toBe(0);
    expect(clampZoom(settings.camera, 0)).toBe(0);
    expect(settings.camera.minimumPitch).toBe(0);
    expect(clampPitch(settings.camera, 0, 10)).toBe(0);
  });

  test("zoom clamping", () => {
    expect(clampZoom(camera({ minimumZoom: 3 }), 1.2)).toBe(3);
    expect(clampZoom(camera({ minimumZoom: 3, maximumZoom: 18 }), 25)).toBe(18);
    expect(clampZoom(camera({ minimumZoom: 3, maximumZoom: 18 }), 7.5)).toBe(7.5);
    expect(clampZoom(camera({ minimumZoom: -5 }), 0)).toBe(0);
    expect(clampZoom(camera({ minimumZoom: 22, maximumZoom: 18 }), 10)).toBe(18);
  });

  test("pitch clamping", () => {
    expect(clampPitch(camera({ minimumPitch: 0.4 }), 0.1, 10)).toBeCloseTo(0.4, 4);
    expect(clampPitch(camera({ minimumPitch: 0.4, maximumPitch: 1.0 }), 1.5, 10)).toBeCloseTo(1.0, 4);
    expect(clampPitch(camera({ minimumPitch: 0.4, maximumPitch: 1.0 }), 0.7, 10)).toBeCloseTo(0.7, 4);
    expect(clampPitch(camera({ minimumPitch: -1 }), -0.5, 10)).toBe(0);
    expect(clampPitch(camera({ minimumPitch: 2.0, maximumPitch: 1.0 }), 0.2, 10)).toBeCloseTo(1.0, 4);
  });
});

describe("the label language", () => {
  test("normalizes a BCP 47 code for the name fields", () => {
    const language = LabelLanguage.make("PT-BR");
    expect(language.code).toBe("pt-br");
    expect(LabelLanguage.nameFieldSuffix(language)).toBe("pt");
    expect(LabelLanguage.preparedTileCacheNamespaceKey(language)).toBe("pt-br");
  });

  test("normalizes an underscore code", () => {
    expect(LabelLanguage.make("pt_BR").code).toBe("pt-br");
    expect(LabelLanguage.make("  ").code).toBe("en");
  });

  test("the namespace key is path safe", () => {
    const key = LabelLanguage.preparedTileCacheNamespaceKey(LabelLanguage.make("EN/../../secret:token"));
    expect(key).not.toContain("/");
    expect(key).not.toContain(":");
    expect(key).not.toContain("..");
  });

  test("the known languages remain available", () => {
    expect(LabelLanguage.english.code).toBe("en");
    expect(LabelLanguage.russian.code).toBe("ru");
  });

  test("the modifier takes a language or its code", () => {
    expect(settings.labelSettings({ language: "RU" }).data.labels.language).toEqual(LabelLanguage.russian);
    expect(settings.labelSettings({ language: LabelLanguage.german }).data.labels.language.code).toBe("de");
    expect(settings.labelSettings({ fallbackPolicy: "localFirst" }).data.labels.language).toEqual(LabelLanguage.english);
  });
});

describe("the air handover", () => {
  test("the handover is a smoothstep over its window", () => {
    const presentation = presentationSettings({ airHandoverStart: 0.6, airHandoverEnd: 0.8 });
    expect(airHandover(presentation, 0)).toBe(0);
    expect(airHandover(presentation, 0.6)).toBe(0);
    expect(airHandover(presentation, 0.65)).toBeCloseTo(0.15625, 6);
    expect(airHandover(presentation, 0.7)).toBeCloseTo(0.5, 6);
    expect(airHandover(presentation, 0.8)).toBe(1);
    expect(airHandover(presentation, 1)).toBe(1);
  });

  test("the defaults hand over before the geometry finishes", () => {
    expect(settings.presentation.airHandoverStart).toBe(0.7);
    expect(settings.presentation.airHandoverEnd).toBe(0.9);
  });

  test("an empty window is a step", () => {
    const presentation = presentationSettings({ airHandoverStart: 0.5, airHandoverEnd: 0.2 });
    expect(airHandover(presentation, 0.49)).toBe(0);
    expect(airHandover(presentation, 0.51)).toBe(1);
  });

  test("the globe modifier leaves the handover as configured", () => {
    const flat = settings.globe({ isEnabled: false });
    expect(flat.presentation.isGlobeEnabled).toBe(false);
    expect(flat.presentation.airHandoverStart).toBe(0.7);
    const tuned = settings.globe({ airHandoverStart: 0.6, airHandoverEnd: 0.85 });
    expect(tuned.presentation).toMatchObject({ isGlobeEnabled: true, airHandoverStart: 0.6, airHandoverEnd: 0.85 });
  });
});
