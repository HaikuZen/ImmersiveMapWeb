// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the snapshot parts of the Swift `DebugOverlayRendererTests`
// and `DebugOverlayHUDLiveTileRowsTests`: the panel's snapshot of a frame,
// what it carries of the loader's rows, and the camera's lines.

import { describe, expect, test } from "vitest";
import { defaultDebugSettings, type DebugSettings } from "../../configuration/view-settings.ts";
import { DebugOverlayHUDContentRequest } from "../../render/debug/debug-overlay-hud-snapshot-store.ts";
import { makePlaceTile } from "../../tile/placement/place-tile.ts";
import { flatRingBand } from "../../tile/visibility/flat-ring-rules.ts";
import { DebugOverlayHUDSnapshot, type DebugOverlayTileLoadingStatus } from "./debug-overlay-hud-snapshot.ts";
import { makeDebugFrameReport } from "./testing/debug-frame-report-fixture.ts";

const panelOn: DebugSettings = { ...defaultDebugSettings, enableDebugPanel: true };

interface Row {
  readonly tile: string;
  readonly detail: string;
}

const parsing: DebugOverlayTileLoadingStatus<Row> = { lines: ["requested 1"], tiles: [{ tile: "z7/77/40", detail: "parse" }] };
const ready: DebugOverlayTileLoadingStatus<Row> = { lines: ["requested 1"], tiles: [{ tile: "z7/77/40", detail: "ready" }] };

describe("DebugOverlayHUDSnapshot", () => {
  test("there is no snapshot with the panel off", () => {
    expect(
      DebugOverlayHUDSnapshot.make({ settings: defaultDebugSettings, zoom: 4, latitude: 55, longitude: 37, cameraDebugLines: [], diagnostics: undefined }),
    ).toBeUndefined();
  });

  test("the snapshot carries the coordinates and the diagnostics lines", () => {
    const snapshot = DebugOverlayHUDSnapshot.make({
      settings: panelOn,
      zoom: 5.412,
      latitude: 55.7558,
      longitude: 37.6173,
      cameraDebugLines: ["camera z:5.41 pitch:36.00 bearing:18.00"],
      diagnostics: {
        frameIndex: 42,
        frameDeltaSeconds: 0.0167,
        cpuMilliseconds: 1,
        gpuMilliseconds: undefined,
        drawCount: 0,
        tiles: { visible: 0, ready: 0, requested: 0, rendered: 0 },
        pending: { terrainTiles: 0, layerMeshes: 0, sceneModelMeshes: 0 },
      },
    });
    expect(snapshot?.coordinateLines).toEqual({ zoom: "z: 5.41", latLon: "lat: 55.756 lon: 37.617" });
    expect(snapshot?.diagnosticsLines).toContain("[Camera]");
    expect(snapshot?.diagnosticsLines).toContain("camera z:5.41 pitch:36.00 bearing:18.00");
    expect(snapshot?.diagnosticsLines.some((line) => line.startsWith("frame:42"))).toBe(true);
    // The planning zoom defaults to the camera's.
    expect(snapshot?.cameraZoom).toBe(5.412);
    expect(snapshot?.textColor).toEqual(panelOn.textColor);
  });

  test("the loader's rows ride on the snapshot, and only with the tiles tab shown", () => {
    const input = { settings: panelOn, zoom: 10, latitude: 0, longitude: 0, cameraDebugLines: [], diagnostics: undefined, tileLoadingStatus: parsing };
    const snapshot = DebugOverlayHUDSnapshot.make(input);
    expect(snapshot?.tileLoadingStatusLines).toEqual(["requested 1"]);
    expect(snapshot?.tileLoadingStatusTiles).toEqual(parsing.tiles);
    const statsOnly = DebugOverlayHUDSnapshot.make({ ...input, content: DebugOverlayHUDContentRequest.stats });
    expect(statsOnly?.tileLoadingStatusTiles).toEqual([]);
  });

  // The panel's refresh between frames reads the rows again from the
  // reporter: a row landing after the last frame is shown on the reporter's
  // word, and a quiet reporter changes nothing.
  test("the between-frames refresh replaces the rows and nothing else", () => {
    const snapshot = DebugOverlayHUDSnapshot.make({ settings: panelOn, zoom: 10, latitude: 0, longitude: 0, cameraDebugLines: [], diagnostics: undefined, tileLoadingStatus: parsing })!;
    const refreshed = DebugOverlayHUDSnapshot.replacingTileLoadingStatus(snapshot, ready);
    expect(refreshed.tileLoadingStatusTiles[0]?.detail).toBe("ready");
    expect({ ...refreshed, tileLoadingStatusTiles: snapshot.tileLoadingStatusTiles }).toEqual(snapshot);
    expect(DebugOverlayHUDSnapshot.isEqual(refreshed, snapshot)).toBe(false);
    expect(DebugOverlayHUDSnapshot.isEqual(DebugOverlayHUDSnapshot.replacingTileLoadingStatus(snapshot, parsing), snapshot)).toBe(true);
    expect(DebugOverlayHUDSnapshot.replacingTileLoadingStatus(snapshot, undefined).tileLoadingStatusLines).toEqual([]);
  });

  test("the view's compass direction is the bearing's opposite turn, 0 to 360", () => {
    expect(DebugOverlayHUDSnapshot.viewAzimuthDegrees(0)).toBe(0);
    expect(DebugOverlayHUDSnapshot.viewAzimuthDegrees(Math.PI / 2)).toBeCloseTo(270, 9);
    expect(DebugOverlayHUDSnapshot.viewAzimuthDegrees(-Math.PI / 2)).toBeCloseTo(90, 9);
    expect(DebugOverlayHUDSnapshot.viewAzimuthDegrees(-5 * Math.PI)).toBeCloseTo(180, 9);
  });

  test("the ring rules line lists each band nearest first", () => {
    expect(DebugOverlayHUDSnapshot.ringRulesLine([])).toBe("rules: none");
    expect(DebugOverlayHUDSnapshot.ringRulesLine([flatRingBand(16, 2, 25), flatRingBand(14, 5, 40)])).toBe("rules: z16 ≤2 (25) / z14 ≤5 (40)");
  });

  test("the zoom counts line counts the tiles of each zoom, coarsest first", () => {
    const tiles = [
      { x: 0, y: 0, z: 13 },
      { x: 1, y: 0, z: 12 },
      { x: 1, y: 1, z: 13 },
    ];
    expect(DebugOverlayHUDSnapshot.zoomCountsLine("srcZ", tiles)).toBe("srcZ: z12:1 z13:2");
    expect(DebugOverlayHUDSnapshot.zoomCountsLine("targetZ", [])).toBe("targetZ: none");
  });

  test("a frame's snapshot: the camera's lines, the frame's sections and the tiles' map", () => {
    const slot = { x: 9903, y: 5122, z: 14 };
    const source = { x: 4951, y: 2561, z: 13 };
    const report = makeDebugFrameReport({ latitude: 55.75, longitude: 37.61, zoom: 14.5, bearing: Math.PI / 6 }, [makePlaceTile({ tile: source }, { tile: slot, worldWrap: 0 })], {
      planningZoom: 14.25,
      flatRingBands: [flatRingBand(14, 3, 1)],
      terrainFollowReport: { path: "hit", armMetres: 1200, clearedZoomDelta: -0.5 },
    });
    const snapshot = DebugOverlayHUDSnapshot.fromFrame<Row>(panelOn, report, ready)!;
    const lines = snapshot.diagnosticsLines;
    for (const line of [
      "[Camera]",
      "camera z:14.50",
      "planning z:14.25",
      "bearing:30.00",
      "surface:flat",
      "viewport:800x600",
      "follow:hit",
      "arm:1,200.00m",
      "clear:-0.50",
      "rules: z14 ≤3 (1)",
      "targetZ: z14:1",
      "srcZ: z13:1",
      "[Frame]",
      "dt:16.70ms",
      "[Tiles]",
    ]) {
      expect(lines).toContain(line);
    }
    // No relief, no relief lines.
    expect(lines.some((line) => line.startsWith("relief:"))).toBe(false);
    expect(snapshot.cameraZoom).toBe(14.25);
    expect(snapshot.zoom).toBe(14.5);
    expect(snapshot.viewAzimuthDegrees).toBeCloseTo(330, 9);
    expect(snapshot.coordinateLines.latLon).toBe("lat: 55.750 lon: 37.610");
    expect(snapshot.tileCoverage?.placements).toEqual([{ slot, source, worldWrap: 0 }]);
    expect(snapshot.tileCoverage?.footprint.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.tileCoverage?.eye).toBeDefined();
    expect(snapshot.reliefStatus).toBeUndefined();
    expect(snapshot.tileLoadingStatusTiles).toEqual(ready.tiles);
  });

  test("a frame's snapshot builds only what the panel shows", () => {
    const report = makeDebugFrameReport({ latitude: 55.75, longitude: 37.61, zoom: 14.5 }, []);
    const snapshot = DebugOverlayHUDSnapshot.fromFrame<Row>(panelOn, report, ready, DebugOverlayHUDContentRequest.relief)!;
    expect(snapshot.diagnosticsLines).toEqual([]);
    expect(snapshot.tileCoverage).toBeUndefined();
    expect(snapshot.tileLoadingStatusTiles).toEqual([]);
    expect(DebugOverlayHUDSnapshot.fromFrame<Row>(defaultDebugSettings, report, ready)).toBeUndefined();
  });
});
