// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The Swift `TileGridSettingsTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { planSettingsApplication } from "./settings-application-planner.ts";
import { clampedTileGridZoomRange, defaultTileGridSettings, tileGridSettings } from "./tile-grid-settings.ts";

describe("TileGridSettings", () => {
  test("the defaults show every zoom and select by a tap, any number of tiles", () => {
    const grid = ImmersiveMapSettings.default.tileGrid;
    expect(grid).toEqual(defaultTileGridSettings);
    expect(grid.zoomRange).toEqual([0, 24]);
    expect([grid.selectionGesture, grid.selectionMode, grid.selectionLimit, grid.selectableBounds]).toEqual(["tap", "multiple", null, null]);
  });

  test("a value set never resets the others, and each is held to what it can be", () => {
    const settings = ImmersiveMapSettings.default.tileGridSettings({ zoomRange: [12, 15], lineWidthPoints: 2 }).tileGridSettings({ labelMaximumWidthShare: 3, minimumTileScreenPoints: -5, maximumDrawnTiles: -1 });
    expect(settings.tileGrid.zoomRange).toEqual([12, 15]);
    expect(settings.tileGrid.lineWidthPoints).toBe(2);
    expect(settings.tileGrid.labelMaximumWidthShare).toBe(1);
    expect(settings.tileGrid.minimumTileScreenPoints).toBe(1);
    expect(settings.tileGrid.maximumDrawnTiles).toBe(0);
    expect(settings.tileGrid.labelFormat).toBe("zxy");
  });

  test("a zoom range is held to the zooms a tile is named at", () => {
    expect(clampedTileGridZoomRange([-3, 40])).toEqual([0, 24]);
    expect(clampedTileGridZoomRange([9, 4])).toEqual([9, 9]);
    expect(tileGridSettings({ zoomRange: [15.9, 15.2] }).zoomRange).toEqual([15, 15]);
  });

  test("the limit and the area are set as given, null included", () => {
    const city = { southWest: { latitude: 55, longitude: 37 }, northEast: { latitude: 56, longitude: 38 } };
    const limited = ImmersiveMapSettings.default.tileGridSelection({ limit: 20, selectableBounds: city });
    expect(limited.tileGrid.selectionLimit).toBe(20);
    expect(limited.tileGrid.selectableBounds).toEqual(city);
    // Another setting leaves them be.
    expect(limited.tileGridSettings({ lineWidthPoints: 3 }).tileGrid.selectionLimit).toBe(20);
    const free = limited.tileGridSelection({ limit: null, selectableBounds: null });
    expect([free.tileGrid.selectionLimit, free.tileGrid.selectableBounds]).toEqual([null, null]);
    expect(ImmersiveMapSettings.default.tileGridSelection({ limit: -4, selectableBounds: null }).tileGrid.selectionLimit).toBe(0);
  });

  test("the grid's settings and the tap's apply live", () => {
    const next = ImmersiveMapSettings.default.tileGridSettings({ zoomRange: [15, 15] });
    const plan = planSettingsApplication(ImmersiveMapSettings.default, next);
    expect([...plan.changedDomains]).toEqual(["tileGrid"]);
    expect(plan.requiresRendererRecreation).toBe(false);
    const taps = planSettingsApplication(ImmersiveMapSettings.default, ImmersiveMapSettings.default.doubleTapZoom(false).tapMovementTolerance(8));
    expect([...taps.changedDomains]).toEqual(["camera"]);
    expect(taps.requiresRendererRecreation).toBe(false);
  });

  test("settings written before the grid was one read with its defaults", () => {
    const { tileGrid: _tileGrid, ...old } = ImmersiveMapSettings.default.data;
    expect(ImmersiveMapSettings.from(JSON.parse(JSON.stringify(old))).tileGrid).toEqual(defaultTileGridSettings);
    const written = ImmersiveMapSettings.default.tileGridSettings({ selectionGesture: "doubleTap" });
    expect(ImmersiveMapSettings.from(JSON.parse(JSON.stringify(written))).tileGrid.selectionGesture).toBe("doubleTap");
  });
});
