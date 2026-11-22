// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayTileCardTests`, with the relief cards,
// the card geometry and the panel's texts.

import { describe, expect, test } from "vitest";
import type { TileLoadingStatusTileSnapshot } from "../../render/debug/tile-loading-status-reporter.ts";
import { GroundReliefStatusSnapshot } from "../../tile/relief/store/ground-relief-status-snapshot.ts";
import type { GroundReliefStatusFields, GroundReliefTileStatus } from "../../tile/relief/store/ground-relief-status-snapshot.ts";
import type { Tile } from "../../tile/tile.ts";
import { DebugOverlayHUDTextComposer, DebugOverlayTileCard, DebugOverlayTileCardLayout } from "./debug-overlay-hud-content.ts";

function snapshot(tile: Tile, fields: Partial<TileLoadingStatusTileSnapshot> = {}): TileLoadingStatusTileSnapshot {
  return { tile, status: "ready", progress: 1, detail: "displayed", preparationStages: [], stageAgeSeconds: 0, ...fields };
}

function reliefStatus(tiles: GroundReliefTileStatus[]): GroundReliefStatusSnapshot {
  const fields: GroundReliefStatusFields = {
    tiles,
    isActive: true,
    standingShare: 1,
    datumMetres: 0,
    cameraTerrainZoom: 12,
    terrainByRing: "",
    wantedCount: tiles.length,
    wantedResidentCount: 0,
    residentCount: 0,
    residentBytes: 0,
    releasedCount: 0,
    releasedBytes: 0,
    releasedCacheBytes: 0,
    occlusionComputedCount: 0,
    occlusionMillisecondsLast: 0,
    loadingCount: 0,
    maximumConcurrentLoads: 4,
    failedCount: 0,
    missingCount: 0,
  };
  return new GroundReliefStatusSnapshot(fields);
}

describe("DebugOverlayTileCard", () => {
  test("a live card shows its age once it is old", () => {
    const tile = { x: 77, y: 40, z: 7 };
    const young = snapshot(tile, { status: "parsing", progress: 0.7, detail: "parse", stageAgeSeconds: 1 });
    const old = snapshot(tile, { status: "parsing", progress: 0.7, detail: "parse", stageAgeSeconds: 12 });
    expect(DebugOverlayTileCard.headline(DebugOverlayTileCard.of(young))).toBe("z7/77/40 parse");
    expect(DebugOverlayTileCard.headline(DebugOverlayTileCard.of(old))).toBe("z7/77/40 parse 12s");
    expect(DebugOverlayTileCard.lines(DebugOverlayTileCard.of(old))).toEqual(["z7/77/40 parse 12s"]);
  });

  test("a finished card never shows an age, and a card without a detail its status", () => {
    expect(DebugOverlayTileCard.of(snapshot({ x: 0, y: 0, z: 0 })).statusText).toBe("displayed");
    const bare = snapshot({ x: 0, y: 0, z: 0 }, { status: "loading", progress: 0.2, detail: "" });
    expect(DebugOverlayTileCard.of(bare).statusText).toBe("network");
  });

  test("the stages and the dearest layers are on the card", () => {
    const card = DebugOverlayTileCard.of(
      snapshot(
        { x: 78, y: 39, z: 7 },
        {
          detail: "ready",
          preparationStages: [
            { name: "disk", duration: 0.003, layerTimings: [] },
            {
              name: "parse",
              duration: 0.062,
              layerTimings: [
                { layerName: "roads", duration: 0.007 },
                { layerName: "landuse", duration: 0.046 },
                { layerName: "places", duration: 0.001 },
                { layerName: "water", duration: 0.002 },
              ],
            },
            { name: "ready", duration: undefined, layerTimings: [] },
          ],
        },
      ),
    );
    expect(card.stagesText).toBe("disk 3ms · parse 62ms · ready");
    expect(card.layersText).toBe("landuse 46ms · roads 7ms · water 2ms");
    expect(DebugOverlayTileCard.lines(card)).toHaveLength(3);
  });

  test("the cards come deepest zoom first and by address within a zoom", () => {
    const tiles = [
      snapshot({ x: 4, y: 3, z: 3 }),
      snapshot({ x: 67, y: 46, z: 7 }),
      snapshot({ x: 33, y: 23, z: 6 }),
      snapshot({ x: 67, y: 45, z: 7 }),
      snapshot({ x: 66, y: 45, z: 7 }),
    ];
    expect(DebugOverlayTileCard.cards(tiles).map((card) => card.title)).toEqual(["z7/66/45", "z7/67/45", "z7/67/46", "z6/33/23", "z3/4/3"]);
  });

  test("a relief card reads the terrain tile's state, demand and heights", () => {
    const tile = { x: 10, y: 20, z: 12 };
    const base = { tile, priority: 0, bytes: 0, heightRange: undefined, seconds: 0, attempts: 0 };
    const cards = DebugOverlayTileCard.reliefCards(
      reliefStatus([
        { ...base, state: "resident", bytes: 1_048_576, heightRange: { lowerBound: 412.4, upperBound: 1877.6 } },
        { ...base, state: "loading", seconds: 3, priority: 1 },
        { ...base, state: "loading", seconds: 1, priority: 2 },
        { ...base, state: "failed", attempts: 2, seconds: 8, priority: undefined },
        { ...base, state: "queued", priority: 4 },
      ]),
    );
    expect(cards.map((card) => card.statusText)).toEqual(["in 1.0 MB", "loading 3s", "loading", "failed ×2 retry 8s", "queued"]);
    expect(cards.map((card) => card.stagesText)).toEqual(["wanted #1", "wanted #2", "wanted #3", "kept", "wanted #5"]);
    expect(cards[0]!.layersText).toBe("412–1878 m");
    expect(cards[1]!.layersText).toBe("");
    expect(cards.map((card) => card.status)).toEqual(["ready", "loading", "loading", "failed", "queued"]);
    expect(cards[0]!.title).toBe("z12/10/20");
  });
});

describe("DebugOverlayTileCardLayout", () => {
  const card = { x: 10, y: 20, width: 250, height: 72 };

  test("the stripe runs down the left edge and the bar along the bottom", () => {
    expect(DebugOverlayTileCardLayout.stripeRect(card)).toEqual({ x: 10, y: 20, width: 4, height: 72 });
    expect(DebugOverlayTileCardLayout.progressTrackRect(card)).toEqual({ x: 22, y: 83, width: 226, height: 3 });
    expect(DebugOverlayTileCardLayout.progressRect(card, 0.5)).toEqual({ x: 22, y: 83, width: 113, height: 3 });
    expect(DebugOverlayTileCardLayout.progressRect(card, 0).width).toBe(3);
    expect(DebugOverlayTileCardLayout.progressRect(card, 2).width).toBe(226);
  });

  test("the lines sit inside the insets, the status right-aligned on the title's line", () => {
    expect(DebugOverlayTileCardLayout.titleRect(card, 17, 60)).toEqual({ x: 22, y: 27, width: 250 - 24 - 60 - 8, height: 17 });
    expect(DebugOverlayTileCardLayout.statusRect(card, 17, 13, 60)).toEqual({ x: 260 - 12 - 60, y: 29, width: 60, height: 13 });
    expect(DebugOverlayTileCardLayout.stagesRect(card, 13).y).toBe(49);
    expect(DebugOverlayTileCardLayout.layersRect(card, 13).y).toBe(66);
  });
});

describe("DebugOverlayHUDTextComposer", () => {
  test("the loader's status and the tile total", () => {
    expect(DebugOverlayHUDTextComposer.tilesStatusText([])).toBe("tiles: idle");
    expect(DebugOverlayHUDTextComposer.tilesStatusText(["requested:3", "active:1"])).toBe("requested:3\nactive:1");
    expect(DebugOverlayHUDTextComposer.tilesTotalText(7)).toBe("tiles total: 7");
  });

  test("the grid density picker maps both ways, an off value to the nearest step", () => {
    expect(DebugOverlayHUDTextComposer.tileGridDensityTitles).toEqual(["2x2", "4x4", "6x6", "8x8"]);
    expect(DebugOverlayHUDTextComposer.tileGridDensityIndex(6)).toBe(2);
    expect(DebugOverlayHUDTextComposer.tileGridDensityIndex(1000)).toBe(3);
    expect(DebugOverlayHUDTextComposer.tileGridDensity(1)).toBe(4);
    expect(DebugOverlayHUDTextComposer.tileGridDensity(9)).toBe(6);
  });

  /** A trace on the web is a file to download, named by its file name rather than a path. */
  test("the trace texts name the file", () => {
    expect(DebugOverlayHUDTextComposer.traceButtonTitle(true)).toBe("Stop recording");
    expect(DebugOverlayHUDTextComposer.traceButtonTitle(false)).toBe("Start recording");
    expect(DebugOverlayHUDTextComposer.tileTraceStatusText({ isRecording: false, fileName: undefined })).toBe("Trace recording is off");
    expect(DebugOverlayHUDTextComposer.tileTraceStatusText({ isRecording: true, fileName: "tile-trace.jsonl" })).toBe("Recording: tile-trace.jsonl");
    expect(DebugOverlayHUDTextComposer.baseLabelTraceStatusText({ isRecording: false, fileName: undefined })).toBe("Base label trace recording is off");
    expect(DebugOverlayHUDTextComposer.baseLabelTraceStatusText({ isRecording: false, fileName: "labels.jsonl" })).toBe("Last trace: labels.jsonl");
  });

  test("without a relief the relief texts say so", () => {
    const off = DebugOverlayHUDTextComposer.reliefTexts(undefined);
    expect(off.state).toBe("relief: off");
    expect(off.loading).toBe("");
    expect(off.occlusion).toBe("relief: off");
    expect(off.surroundings).toBe("around: off the terrain");
    expect(off.tilesCount).toBe("terrain tiles: 0");
    const on = DebugOverlayHUDTextComposer.reliefTexts(reliefStatus([]));
    expect(on.state.startsWith("relief: on the terrain")).toBe(true);
  });
});
