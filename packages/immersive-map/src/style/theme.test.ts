// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `NightThemeTests` (the palette), `ProtomapsBasemapThemeTests`
// (`apply`), `ImmersiveMapLabelOpacityTests` (the curves) and the theme
// parts of `ImmersiveMapSettingsDefaultsTests` and
// `BuildingExtrusionToggleTests`. The cache fingerprint is the `map-style`
// crate's, so its tests stay there.

import { describe, expect, test } from "vitest";
import {
  applyTheme,
  defaultLabelOpacity,
  defaultLayerStyles,
  defaultLabelStyles,
  defaultTheme,
  labelOpacityFrame,
  nightTheme,
  routeShieldAppearance,
  themeBaseColors,
  themesPrepareAlike,
  treeFillStyle,
} from "./theme.ts";
import { zoomCurve } from "../configuration/zoom-curve.ts";

describe("the night palette", () => {
  /** The night is its own palette, baked into its own tiles: a dark land and water, light grey labels, the biomes sunk. */
  test("the night palette is dark and its own identity", () => {
    const day = defaultTheme;
    const night = nightTheme;
    expect(themesPrepareAlike(night, day)).toBe(false);
    expect(night.layers.land[0] + night.layers.land[1] + night.layers.land[2]).toBeLessThan(0.5);
    expect(night.layers.water[1]).toBeLessThan(day.layers.water[1]);
    expect(night.labels.city.fillColor[0]).toBeGreaterThan(0.75);
    expect(night.labels.city.fillColor[0]).toBeLessThan(0.9);
    expect(night.labels.city.fillColor[0]).toBeGreaterThan(night.labels.town.fillColor[0]);
    expect(night.labels.town.fillColor[0]).toBeGreaterThan(night.labels.district.fillColor[0]);
    expect(night.labels.city.strokeColor[0]).toBeLessThan(0.1);
    expect(night.layers.biomes.temperateBroadleafForest[1]).toBeLessThan(day.layers.biomes.temperateBroadleafForest[1] * 0.5);
    const forest = night.layers.biomes.temperateBroadleafForest;
    const desert = night.layers.biomes.desert;
    expect(forest[1] - forest[0]).toBeGreaterThan(desert[1] - desert[0]);
    expect(night.roadMetrics).toEqual(day.roadMetrics);
    const plate = night.routeShields.fallback;
    expect(plate).not.toBeNull();
    expect(plate?.fillColor[0]).toBeLessThan(0.6);
    expect(plate?.fillColor[0]).toBeGreaterThan(0.4);
    expect(plate?.borderColor[0] ?? 1).toBeLessThan(plate?.fillColor[0] ?? 0);
    const food = night.labels.poiCategories.food;
    expect(food[0]).toBeLessThan(day.labels.poiCategories.food[0] * 0.6);
    expect(food[0]).toBeGreaterThan(food[2] * 2);
    expect(plate?.textColor).toEqual(day.routeShields.fallback?.textColor);
    const russia = night.routeShields.rules.find((rule) => rule.network === "ru:national")?.appearance;
    const dayRussia = day.routeShields.rules.find((rule) => rule.network === "ru:national")?.appearance;
    expect(russia).toBeTruthy();
    expect(russia?.fillColor[0] ?? 1).toBeLessThan(dayRussia?.fillColor[0] ?? 0);
    expect(russia?.fillColor[0] ?? 0).toBeGreaterThan((russia?.fillColor[1] ?? 1) * 3);
    expect(russia?.textColor[0] ?? 1).toBeLessThan(1);
    expect(night.routeShields.rules.map((rule) => rule.network)).toEqual(day.routeShields.rules.map((rule) => rule.network));
    expect(night.routeShields.minimumTileZoom).toEqual(day.routeShields.minimumTileZoom);
    expect(night.labelVisibility).toEqual(day.labelVisibility);
    expect(themeBaseColors(night).map).toEqual(night.layers.land);
  });

  /** The night is the map's, not the planet's: the globe wears the day's palette. */
  test("the globe of the night is the day's", () => {
    expect(nightTheme.globeLayers).toEqual(defaultTheme.layers);
    expect(nightTheme.globeLabels).toEqual(defaultTheme.labels);
    expect(defaultTheme.globeLayers).toBeNull();
    expect(defaultTheme.globeLabels).toBeNull();
    expect(themeBaseColors(nightTheme).northCap).toEqual(defaultTheme.layers.water);
  });
});

describe("the theme", () => {
  /** `applyTheme` is a copy with the changes: the original is untouched. */
  test("apply makes a changed copy", () => {
    const water = [0.2, 0.4, 0.8, 1] as const;
    const recoloured = applyTheme(defaultTheme, (theme) => {
      theme.layers.water = [...water];
    });
    expect(defaultTheme.layers.water).toEqual([0.647, 0.812, 0.945, 1.0]);
    expect(recoloured.layers.water).toEqual(water);
    expect(themesPrepareAlike(defaultTheme, recoloured)).toBe(false);
    expect(Object.isFrozen(recoloured.layers.water)).toBe(true);
  });

  /** What no tile paints comes from the same palette as the tiles. */
  test("the base colours are the theme's land, water and ice", () => {
    const base = themeBaseColors(defaultTheme);
    expect(base.map).toEqual(defaultTheme.layers.land);
    expect(base.northCap).toEqual(defaultTheme.layers.water);
    expect(base.southCap).toEqual(defaultTheme.layers.ice);
  });

  test("the extrusion is on by default", () => {
    expect(defaultTheme.features.buildingExtrusion).toBe(true);
  });

  test("the values drawn at frame time leave the prepared tiles alike", () => {
    const shaded = applyTheme(defaultTheme, (theme) => {
      theme.hillshade.intensity = 0;
      theme.terrainOcclusion.isEnabled = false;
    });
    expect(themesPrepareAlike(defaultTheme, shaded)).toBe(true);
    const signedZero = applyTheme(defaultTheme, (theme) => {
      theme.labels.town.haloEm = -0;
    });
    const positiveZero = applyTheme(defaultTheme, (theme) => {
      theme.labels.town.haloEm = 0;
    });
    expect(themesPrepareAlike(signedZero, positiveZero)).toBe(true);
  });

  test("the JSON of a theme is the same theme", () => {
    expect(JSON.parse(JSON.stringify(nightTheme))).toEqual(nightTheme);
    expect(Object.keys(defaultTheme)).toEqual([
      "labels",
      "globeLabels",
      "labelVisibility",
      "layers",
      "globeLayers",
      "features",
      "roadMetrics",
      "routeShields",
      "hillshade",
      "terrainOcclusion",
      "labelOpacity",
    ]);
    expect(defaultLayerStyles.trees.wood).toEqual(treeFillStyle({ spacingMetres: 9, heightMetres: [7, 11] }));
    expect(defaultLabelStyles.city.sizePoints).toBe(15);
  });

  test("a route sign keeps its values within their ranges", () => {
    const sign = routeShieldAppearance({ fillColor: [1, 0, 0], textColor: [1, 1, 1], borderEm: -1, headerFraction: 2 });
    expect(sign.borderColor).toEqual([1, 0, 0]);
    expect(sign.borderEm).toBe(0);
    expect(sign.headerFraction).toBe(0.5);
    expect(sign.shape).toBe("rectangle");
  });
});

describe("the labels' opacity", () => {
  test("the default leaves every label at its own opacity", () => {
    expect(labelOpacityFrame(defaultLabelOpacity, 12)).toEqual({ names: 1, pois: 1 });
    expect(defaultTheme.labelOpacity).toEqual(defaultLabelOpacity);
  });

  test("the curves are read at the zoom and held to the unit range", () => {
    const opacity = { names: zoomCurve({ 2: 1, 6: 0.4 }), pois: zoomCurve({ 14: 1.5, 16: -0.2 }) };
    expect(labelOpacityFrame(opacity, 1).names).toBe(1);
    expect(labelOpacityFrame(opacity, 8).names).toBeCloseTo(0.4, 6);
    expect(labelOpacityFrame(opacity, 10).pois).toBe(1);
    expect(labelOpacityFrame(opacity, 18).pois).toBe(0);
  });
});
