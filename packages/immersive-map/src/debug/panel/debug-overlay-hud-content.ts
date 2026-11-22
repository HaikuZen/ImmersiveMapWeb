// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { DebugTileGridDensity } from "../../render/debug/debug-tile-grid-density.ts";
import type { TraceRecorderSnapshot } from "../../render/debug/json-lines-trace.ts";
import type { TileLoadingStatusTileSnapshot, TileLoadingTileStatus } from "../../render/debug/tile-loading-status-reporter.ts";
import type { GroundReliefStatusSnapshot } from "../../tile/relief/store/ground-relief-status-snapshot.ts";
import type { Tile } from "../../tile/tile.ts";
import type { DebugOverlayRect } from "./debug-overlay-geometry.ts";
import { formatFixed, rectIntersection, rectMaxX, rectMaxY, swiftRounded } from "./debug-overlay-geometry.ts";

/** The texts of the Relief tab's groups, each a block of lines, and the terrain tiles' count line. */
export interface DebugOverlayReliefTexts {
  readonly state: string;
  readonly loading: string;
  readonly memory: string;
  readonly occlusion: string;
  readonly surroundings: string;
  /** Drawn in the highlight colour, like `tilesTotalText`. */
  readonly tilesCount: string;
}

/**
 * The debug panel's texts (the Swift `DebugOverlayHUDTextComposer`): the
 * strings the panel shows, kept apart from the controls that show them.
 */
export const DebugOverlayHUDTextComposer = {
  /** The loader's status, a line a value, or that it is idle. */
  tilesStatusText(lines: readonly string[]): string {
    return lines.length === 0 ? "tiles: idle" : lines.join("\n");
  },

  /** The summary of the tile list: how many tiles are tracked in all, drawn in a highlight colour apart from the white status. */
  tilesTotalText(count: number): string {
    return `tiles total: ${count}`;
  },

  /** The titles of the tile grid density picker, in `DebugTileGridDensity.options` order. */
  tileGridDensityTitles: Object.freeze(DebugTileGridDensity.options.map((density) => `${density}x${density}`)) as readonly string[],

  tileGridDensityIndex(density: number): number {
    return Math.max(DebugTileGridDensity.options.indexOf(DebugTileGridDensity.clamp(density)), 0);
  },

  tileGridDensity(index: number): number {
    return DebugTileGridDensity.options[index] ?? DebugTileGridDensity.standard;
  },

  traceButtonTitle(isRecording: boolean): string {
    return isRecording ? "Stop recording" : "Start recording";
  },

  /** The tile trace's status: the file being recorded or the last one, by the name it downloads under. */
  tileTraceStatusText(snapshot: TraceRecorderSnapshot): string {
    if (snapshot.fileName === undefined) return "Trace recording is off";
    return `${snapshot.isRecording ? "Recording" : "Last trace"}: ${snapshot.fileName}`;
  },

  /** The base label trace's status, as the tile trace's. */
  baseLabelTraceStatusText(snapshot: TraceRecorderSnapshot): string {
    if (snapshot.fileName === undefined) return "Base label trace recording is off";
    return `${snapshot.isRecording ? "Recording" : "Last trace"}: ${snapshot.fileName}`;
  },

  /**
   * The Relief and AO tabs' texts of a terrain store's status. Without a
   * relief the first group says so and the rest stay empty.
   */
  reliefTexts(status: GroundReliefStatusSnapshot | undefined): DebugOverlayReliefTexts {
    const text = (lines: readonly string[]) => lines.join("\n");
    return {
      state: text(status?.stateLines ?? ["relief: off"]),
      loading: text(status?.loadingLines ?? []),
      memory: text(status?.memoryLines ?? []),
      occlusion: text(status?.occlusionLines ?? ["relief: off"]),
      surroundings: text(status?.surroundingsLines ?? ["around: off the terrain"]),
      tilesCount: `terrain tiles: ${status?.tiles.length ?? 0}`,
    };
  },

  /** The Export tab's text under its button before the first export. */
  exportHint: "Writes the sky, fog, light, shadows and atmosphere as settings modifiers to a file to download",
  exportButtonTitle: "Export settings to a file",
  /** The Export tab's text after an export: the file's name as it downloads. */
  exportStatusText(fileName: string): string {
    return `Saved: ${fileName}`;
  },
  surfaceModeButtonTitle: "Switch globe / flat",
  controlsGroupTitle: "Controls",
  axesTitle: "Axes",
  tileLayersTitle: "Tile layers",
  tileGridTitle: "Tile grid",
  wireframeTitle: "Wireframe",
} as const;

/**
 * One tile of the panel's tile list, as a card (the Swift
 * `DebugOverlayTileCard`): everything the list knows of the tile at a
 * glance, with no row to open. `DebugOverlayTileCardLayout` says where its
 * parts are drawn.
 */
export interface DebugOverlayTileCard {
  readonly tile: Tile;
  readonly status: TileLoadingTileStatus;
  readonly progress: number;
  /** The tile's address: "z7/67/45". */
  readonly title: string;
  /** What the tile is doing or has become, and for how long once that is worth saying: "parse 12s", "displayed". */
  readonly statusText: string;
  /** Every preparation stage with its time, in order: "disk 3ms · parse 62ms · ready". Empty before the first stage. */
  readonly stagesText: string;
  /** The parse's dearest layers, `layerCount` at most, the dearest first: "landuse 46ms · roads 7ms". Empty until the parse reports. */
  readonly layersText: string;
}

function tileTitle(tile: Tile): string {
  return `z${tile.z}/${tile.x}/${tile.y}`;
}

export const DebugOverlayTileCard = {
  layerCount: 3,
  /** A live stage younger than this many seconds shows no age: every card would flicker a "0s" or "1s" for the moment a healthy stage takes. */
  stageAgeDisplayThreshold: 2,
  separator: " · ",

  /** The card of a loader's tile. */
  of(snapshot: TileLoadingStatusTileSnapshot): DebugOverlayTileCard {
    const card = DebugOverlayTileCard;
    const detail = snapshot.detail.length === 0 ? card.statusText(snapshot.status) : snapshot.detail;
    const age = snapshot.stageAgeSeconds >= card.stageAgeDisplayThreshold ? ` ${snapshot.stageAgeSeconds}s` : "";
    const stagesText = snapshot.preparationStages
      .map((stage) => (stage.duration === undefined ? stage.name : `${stage.name} ${card.millisecondsDescription(stage.duration)}`))
      .join(card.separator);
    const timings = snapshot.preparationStages.find((stage) => stage.name === "parse")?.layerTimings ?? [];
    const layersText = [...timings]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, card.layerCount)
      .map((timing) => `${timing.layerName} ${card.millisecondsDescription(timing.duration)}`)
      .join(card.separator);
    return {
      tile: snapshot.tile,
      status: snapshot.status,
      progress: snapshot.progress,
      title: tileTitle(snapshot.tile),
      statusText: detail + age,
      stagesText,
      layersText,
    };
  },

  /** The first line: the address and the status. */
  headline(card: DebugOverlayTileCard): string {
    return `${card.title} ${card.statusText}`;
  },

  /** The card's text line by line, the empty lines left out. */
  lines(card: DebugOverlayTileCard): string[] {
    return [DebugOverlayTileCard.headline(card), card.stagesText, card.layersText].filter((line) => line.length > 0);
  },

  /**
   * The cards of the list: the deepest zoom first, since those are the
   * tiles on screen, and the tiles of a zoom by their address, so a tile is
   * found where it was last time whatever order the loader reports them in.
   */
  cards(tiles: readonly TileLoadingStatusTileSnapshot[]): DebugOverlayTileCard[] {
    return [...tiles]
      .sort((a, b) => {
        if (a.tile.z !== b.tile.z) return b.tile.z - a.tile.z;
        if (a.tile.x !== b.tile.x) return a.tile.x - b.tile.x;
        return a.tile.y - b.tile.y;
      })
      .map((snapshot) => DebugOverlayTileCard.of(snapshot));
  },

  /**
   * The cards of the Relief tab, one per terrain tile in the order the store
   * lists them, the frame's wanted tiles nearest first: the address, what
   * the tile is doing ("in 1.0 MB", "loading 3s", "failed ×2 retry 8s",
   * "queued"), its place in the frame's demand or "kept" for one held from
   * earlier frames, and its heights.
   */
  reliefCards(snapshot: GroundReliefStatusSnapshot): DebugOverlayTileCard[] {
    const threshold = DebugOverlayTileCard.stageAgeDisplayThreshold;
    return snapshot.tiles.map((entry) => {
      let status: TileLoadingTileStatus;
      let progress: number;
      let statusText: string;
      switch (entry.state) {
        case "resident":
          status = "ready";
          progress = 1;
          statusText = `in ${formatFixed(entry.bytes / 1_048_576, 1)} MB`;
          break;
        case "loading":
          status = "loading";
          progress = 0.5;
          statusText = entry.seconds >= threshold ? `loading ${entry.seconds}s` : "loading";
          break;
        case "failed":
          status = "failed";
          progress = 0;
          statusText = `failed ×${entry.attempts} retry ${entry.seconds}s`;
          break;
        case "queued":
          status = "queued";
          progress = 0.1;
          statusText = "queued";
          break;
      }
      const demand = entry.priority === undefined ? "kept" : `wanted #${entry.priority + 1}`;
      const heights =
        entry.heightRange === undefined
          ? ""
          : `${formatFixed(entry.heightRange.lowerBound, 0)}–${formatFixed(entry.heightRange.upperBound, 0)} m`;
      return { tile: entry.tile, status, progress, title: tileTitle(entry.tile), statusText, stagesText: demand, layersText: heights };
    });
  },

  /** A status as the card reads it when the loader gives no detail. */
  statusText(status: TileLoadingTileStatus): string {
    switch (status) {
      case "queued":
        return "queued";
      case "loading":
        return "network";
      case "parsing":
        return "parse";
      case "ready":
        return "ready";
      case "failed":
        return "failed";
    }
  },

  /** A duration in seconds as whole milliseconds: "62ms". */
  millisecondsDescription(seconds: number): string {
    return `${swiftRounded(seconds * 1000)}ms`;
  },

  /** The colour of a card's stripe and progress bar: green when ready, red when failed, yellow while queued or at work. */
  statusTone(status: TileLoadingTileStatus): "ready" | "failed" | "live" {
    return status === "ready" ? "ready" : status === "failed" ? "failed" : "live";
  },
} as const;

/**
 * The geometry of a tile card (the Swift `DebugOverlayTileCardLayout`): a
 * rounded block with a stripe of the status colour down its left edge, the
 * address and the status on its first line, the stages on its second, the
 * dearest parse layers on its third, and a thin progress bar along its
 * bottom. The cards fill the list's width in as many columns as
 * `minimumWidth` allows (`DebugOverlayPanelLayout.cardColumnCount`). In CSS
 * pixels from the card's top left.
 */
export const DebugOverlayTileCardLayout = {
  height: 72,
  spacing: 6,
  minimumWidth: 250,
  cornerRadius: 8,
  inset: 12,
  stripeWidth: 4,
  titleTop: 7,
  stagesTop: 29,
  layersTop: 46,
  progressHeight: 3,
  progressBottomInset: 6,
  titleFontSize: 13.5,
  detailFontSize: 11,
  backgroundAlpha: 0.32,
  tintAlpha: 0.16,
  progressTrackAlpha: 0.35,
  progressAlpha: 0.9,
  /** The gap between the title and the status on the first line. */
  titleStatusGap: 8,

  stripeRect(card: DebugOverlayRect): DebugOverlayRect {
    return { x: card.x, y: card.y, width: DebugOverlayTileCardLayout.stripeWidth, height: card.height };
  },

  progressTrackRect(card: DebugOverlayRect): DebugOverlayRect {
    const layout = DebugOverlayTileCardLayout;
    return {
      x: card.x + layout.inset,
      y: rectMaxY(card) - layout.progressBottomInset - layout.progressHeight,
      width: Math.max(0, card.width - layout.inset * 2),
      height: layout.progressHeight,
    };
  },

  /** The bar's filled part: the progress's share of the track, a dot at least, inside the track. */
  progressRect(card: DebugOverlayRect, progress: number): DebugOverlayRect {
    const layout = DebugOverlayTileCardLayout;
    const track = layout.progressTrackRect(card);
    const share = Math.min(1, Math.max(0, progress));
    return rectIntersection(
      { x: track.x, y: track.y, width: Math.max(layout.progressHeight, track.width * share), height: track.height },
      track,
    );
  },

  titleRect(card: DebugOverlayRect, lineHeight: number, statusWidth: number): DebugOverlayRect {
    const layout = DebugOverlayTileCardLayout;
    return {
      x: card.x + layout.inset,
      y: card.y + layout.titleTop,
      width: Math.max(0, card.width - layout.inset * 2 - statusWidth - layout.titleStatusGap),
      height: lineHeight,
    };
  },

  /** The status, right-aligned on the title's line and centred on it. */
  statusRect(card: DebugOverlayRect, titleLineHeight: number, lineHeight: number, width: number): DebugOverlayRect {
    const layout = DebugOverlayTileCardLayout;
    return {
      x: rectMaxX(card) - layout.inset - width,
      y: card.y + layout.titleTop + (titleLineHeight - lineHeight) * 0.5,
      width,
      height: lineHeight,
    };
  },

  stagesRect(card: DebugOverlayRect, lineHeight: number): DebugOverlayRect {
    const layout = DebugOverlayTileCardLayout;
    return { x: card.x + layout.inset, y: card.y + layout.stagesTop, width: Math.max(0, card.width - layout.inset * 2), height: lineHeight };
  },

  layersRect(card: DebugOverlayRect, lineHeight: number): DebugOverlayRect {
    const layout = DebugOverlayTileCardLayout;
    return { x: card.x + layout.inset, y: card.y + layout.layersTop, width: Math.max(0, card.width - layout.inset * 2), height: lineHeight };
  },
} as const;
