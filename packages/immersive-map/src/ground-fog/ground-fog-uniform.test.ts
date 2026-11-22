// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GroundFogTests` (the settings' modifiers are covered by
// configuration/modifiers.test.ts).

import { describe, expect, test } from "vitest";
import type { ViewMode } from "../camera/view-mode.ts";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { presentationSettings } from "../configuration/presentation-settings.ts";
import type { Vec3 } from "../math/vec.ts";
import { GroundFogUniform } from "./ground-fog-uniform.ts";
import groundFogSource from "./shaders/ground-fog.wgsl?raw";

const eye: Vec3 = [0, -3, 4];
/** One render unit is 100 m. */
const worldUnitsPerMeter = 0.01;
const base = ImmersiveMapSettings.default;

function uniform(settings: ImmersiveMapSettings, surface: ViewMode = "flat", zoom = 16) {
  return GroundFogUniform.resolve({ settings, renderSurfaceMode: surface, cameraEye: eye, worldUnitsPerMeter, zoom });
}

describe("GroundFogUniform", () => {
  test("the relief's altitude reaches the shader", () => {
    expect(base.scene.groundFog.heightsFromSeaLevel).toBe(true);
    expect(base.scene.groundFog.baseAltitudeMeters).toBe(0);
    expect(uniform(base, "flat", 12).startSoftness[1]).toBe(0);
    const common = { renderSurfaceMode: "flat" as const, cameraEye: eye, worldUnitsPerMeter, zoom: 12, onGroundRelief: true, datumMetres: 1608 };
    const overZermatt = GroundFogUniform.resolve({ ...common, settings: base.groundFog({ baseAltitudeMeters: 1500 }) });
    expect(overZermatt.startSoftness[1]).toBe(1608);
    expect(overZermatt.startSoftness[2]).toBe(1500);
    const fromPlane = GroundFogUniform.resolve({ ...common, settings: base.groundFog({ heightsFromSeaLevel: false, baseAltitudeMeters: 1500 }) });
    expect(fromPlane.startSoftness[1]).toBe(0);
    expect(fromPlane.startSoftness[2]).toBe(0);
  });

  test("the fog is on by default and off the globe", () => {
    expect(base.scene.groundFog.isEnabled).toBe(true);
    expect(uniform(base).parameters[3]).toBe(1);
    expect(uniform(base, "spherical").parameters[3]).toBe(0);
    expect(uniform(base.groundFog({ isEnabled: false })).parameters[3]).toBe(0);
  });

  test("the uniform carries meters", () => {
    const fogged = uniform(base.groundFog({ densityPerKilometer: 2, heightMeters: 50, startDistanceMeters: 300, startSoftnessMeters: 700, maximumOpacity: 0.8 }));
    expect(fogged.eyeAndMetersPerUnit[3]).toBeCloseTo(100, 4);
    expect(fogged.eyeAndMetersPerUnit.slice(0, 3)).toEqual([...eye]);
    expect(fogged.colorAndDensity[3]).toBeCloseTo(0.002, 9);
    expect(fogged.parameters).toEqual([50, 300, 0.8, 1]);
    expect(fogged.startSoftness[0]).toBe(700);
  });

  test("the values follow the zoom", () => {
    const settings = base.groundFog({
      densityPerKilometer: { 12: 0.1, 16: 1.6 },
      heightMeters: { 12: 2000, 16: 125 },
      startDistanceMeters: { 12: 3200, 16: 200 },
      maximumOpacity: { 12: 0.5, 16: 1 },
    });
    const low = uniform(settings, "flat", 10);
    expect(low.colorAndDensity[3]).toBeCloseTo(0.0001, 9);
    expect(low.parameters).toEqual([2000, 3200, 0.5, 1]);
    expect(uniform(settings, "flat", 18).parameters).toEqual([125, 200, 1, 1]);
    const middle = uniform(settings, "flat", 14);
    expect(middle.colorAndDensity[3]).toBeCloseTo(0.0004, 8);
    expect(middle.parameters[0]).toBeCloseTo(500, 2);
    expect(middle.parameters[1]).toBeCloseTo(800, 2);
    expect(middle.parameters[2]).toBeCloseTo(0.75, 6);
  });

  test("a zero opacity is no fog", () => {
    const settings = base.groundFog({ maximumOpacity: { 14: 0, 15: 1 } });
    expect(uniform(settings, "flat", 13).parameters[3]).toBe(0);
    expect(uniform(settings, "flat", 15).parameters[3]).toBe(1);
  });

  test("the fog comes in past the globe's morph", () => {
    const presentation = base.presentation;
    const planeZoom = presentation.automaticTransitionStartZoom + presentation.automaticTransitionSpan;
    const width = presentation.automaticTransitionSpan * GroundFogUniform.morphFadeSpanShare;
    expect(GroundFogUniform.morphFade(presentation, planeZoom)).toBe(0);
    expect(GroundFogUniform.morphFade(presentation, planeZoom + width / 2)).toBeCloseTo(0.5, 6);
    expect(GroundFogUniform.morphFade(presentation, planeZoom + width)).toBe(1);
    expect(GroundFogUniform.morphFade(presentationSettings({ isGlobeEnabled: false }), 0)).toBe(1);
    expect(uniform(base, "flat", planeZoom).parameters[3]).toBe(0);
  });

  test("above the line the fog is the sky", () => {
    expect(uniform(base).skyColorAndGradient[3]).toBe(0);
    const settings = base.groundFog({ takesSkyColor: true });
    const fog = uniform(settings);
    const horizon = settings.scene.fog.horizonColor;
    const sky = settings.scene.fog.skyColor;
    expect(fog.skyColorAndGradient[3]).toBeCloseTo((2.5 * Math.PI) / 180, 12);
    expect(GroundFogUniform.color(fog, -0.1)).toEqual([...horizon]);
    expect(GroundFogUniform.color(fog, 0)).toEqual([...horizon]);
    const high = GroundFogUniform.color(fog, Math.PI / 4);
    expect(high[0]).toBeCloseTo(sky[0], 3);
    expect(high[2]).toBeCloseTo(sky[2], 3);
    expect(GroundFogUniform.color(uniform(settings.fog({ isEnabled: false })), Math.PI / 4)).toEqual([...horizon]);
  });

  test("the colour is the horizon's by default", () => {
    const settings = base.fogSettings({ horizonColor: [0.1, 0.2, 0.3] });
    expect(uniform(settings).colorAndDensity.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(uniform(settings.groundFog({ color: [0.9, 0.8, 0.7] })).colorAndDensity.slice(0, 3)).toEqual([0.9, 0.8, 0.7]);
  });

  test("the buildings draw with the share of the fog that veils them", () => {
    const settings = base.groundFog({ veilsBuildings: false });
    const at = (s: ImmersiveMapSettings) => GroundFogUniform.resolve({ settings: s, renderSurfaceMode: "flat", cameraEye: eye, worldUnitsPerMeter, zoom: 16, forBuildings: true });
    expect(at(base).parameters[3]).toBe(1);
    expect(at(settings).parameters[3]).toBe(0);
  });

  test("the uniform's layout is the shader struct's: five vec4f", () => {
    const struct = /struct GroundFog \{([\s\S]*?)\n\}/.exec(groundFogSource)?.[1] ?? "";
    expect([...struct.matchAll(/^\s*(\w+): vec4f,/gm)].map((m) => m[1])).toEqual([
      "colorAndDensity",
      "eyeAndMetersPerUnit",
      "parameters",
      "skyColorAndGradient",
      "startSoftness",
    ]);
    expect(GroundFogUniform.byteLength).toBe(80);
    const target = new Float32Array(20);
    GroundFogUniform.write(target, 0, uniform(base));
    expect(target[11]).toBe(1);
    expect(groundFogSource).toContain("fn applyGroundFog(");
  });
});
