// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The parse options part carries over `TileQuartersTests.testTheTilesThatKeepQuarters`
// and the parse assertion of `TileMaximumZoomLevelSettingsTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { applyTheme, defaultTheme, protomapsBasemapMapStyle } from "../../style/theme.ts";
import { labelAtlasGlyphs, preparedTileCacheNamespace, tileParseOptionsConfig, tileParserConfig } from "./tile-parser-config.ts";

const archive = "https://tiles.example.com/planet.pmtiles";

describe("tileParseOptionsConfig", () => {
  test("the defaults: buildings from zoom 14, the deepest zoom 15, trees from the buildings' zoom", () => {
    const options = tileParseOptionsConfig(ImmersiveMapSettings.default);
    expect(options.buildingMinimumSourceZoom).toBe(14);
    expect(options.buildingDeepestSourceZoom).toBe(15);
    expect(options.labelsEnabled).toBe(true);
    expect(options.addTestBorders).toBe(false);
    expect(options.groundReliefEnabled).toBe(false);
    const settings = ImmersiveMapSettings.default;
    expect(options.treeMinimumSourceZoom).toBe(settings.scene.trees.isEnabled ? 14 : null);
    expect(options.treeMaximumPerTile).toBe(settings.scene.trees.maximumPerTile);
  });

  test("the parse reads the archive's depth", () => {
    expect(tileParseOptionsConfig(ImmersiveMapSettings.default.tileMaximumZoomLevel(14)).buildingDeepestSourceZoom).toBe(14);
  });

  test("the trees off place none", () => {
    expect(tileParseOptionsConfig(ImmersiveMapSettings.default.trees({ isEnabled: false })).treeMinimumSourceZoom).toBeNull();
  });

  test("the flattening's grids are clamped and keyed by zoom", () => {
    const settings = ImmersiveMapSettings.default.groundFlattening({ grid: 1000, gridByTileZoom: { 12: 0, 13: 96 } });
    const options = tileParseOptionsConfig(settings);
    expect(options.groundFlatteningGrid).toBe(256);
    expect(options.groundFlatteningGridByTileZoom).toEqual({ "12": 1, "13": 96 });
  });

  test("the relief raises the flattened ground", () => {
    expect(tileParseOptionsConfig(ImmersiveMapSettings.default.groundRelief({ isEnabled: true })).groundReliefEnabled).toBe(true);
  });
});

describe("tileParserConfig", () => {
  test("the built-in styles go by their palette, with no theme", () => {
    const day = tileParserConfig(ImmersiveMapSettings.default, []);
    expect(day.palette).toBe("light");
    expect(day.theme).toBeUndefined();
    const night = tileParserConfig(ImmersiveMapSettings.default.night(), []);
    expect(night.palette).toBe("night");
    expect(night.theme).toBeUndefined();
  });

  test("a theme of the app's own is sent whole", () => {
    const theme = applyTheme(defaultTheme, (t) => {
      t.layers.water = [0.2, 0.4, 0.8, 1];
    });
    const config = tileParserConfig(ImmersiveMapSettings.default.mapStyle(protomapsBasemapMapStyle(theme)), []);
    expect(config.theme?.layers.water).toEqual([0.2, 0.4, 0.8, 1]);
  });

  test("the label policy and the glyphs", () => {
    const config = tileParserConfig(ImmersiveMapSettings.default.labelSettings({ language: "pt_BR", fallbackPolicy: "localFirst" }), [65, 66]);
    expect(config.language).toBe("pt-br");
    expect(config.fallbackPolicy).toBe("localFirst");
    expect(config.glyphs).toEqual([65, 66]);
  });

  test("the config is plain JSON", () => {
    const config = tileParserConfig(ImmersiveMapSettings.default, [32]);
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });
});

describe("labelAtlasGlyphs", () => {
  test("the code points of every atlas, once each, ascending", () => {
    const glyphs = labelAtlasGlyphs([{ glyphs: [{ unicode: 66 }, { unicode: 32 }] }, { glyphs: [{ unicode: 1046 }, { unicode: 66 }] }]);
    expect(glyphs).toEqual([32, 66, 1046]);
  });
});

describe("preparedTileCacheNamespace", () => {
  const settings = ImmersiveMapSettings.default;
  const namespace = (s: ImmersiveMapSettings, url = archive, glyphs: number[] = []) => preparedTileCacheNamespace(s, url, tileParserConfig(s, glyphs));

  test("stable for the same inputs", () => {
    expect(namespace(settings)).toBe(namespace(settings));
  });

  test("another archive, language, style, glyph set or overview is another namespace", () => {
    const base = namespace(settings);
    expect(namespace(settings, "https://tiles.example.com/other.pmtiles")).not.toBe(base);
    expect(namespace(settings.labelSettings({ language: "fr" }))).not.toBe(base);
    expect(namespace(settings.night())).not.toBe(base);
    expect(namespace(settings, archive, [65])).not.toBe(base);
    expect(namespace(settings.overviewTiles({ isEnabled: false }))).not.toBe(base);
  });

  test("the relief is prepared-cache identity", () => {
    // The Swift `GroundReliefRoadParseTests.testTheReliefIsPreparedCacheIdentity`:
    // a tile parsed with its roads cut at the grid is never served to a map laid flat.
    expect(namespace(settings.groundRelief({ isEnabled: true }))).not.toBe(namespace(settings.groundRelief({ isEnabled: false })));
  });

  test("header names are identity, header values are not", () => {
    const a = settings.tileArchive(archive, { Authorization: "Bearer one" });
    const b = settings.tileArchive(archive, { Authorization: "Bearer two" });
    expect(namespace(a)).toBe(namespace(b));
    expect(namespace(a)).not.toBe(namespace(settings));
  });
});
