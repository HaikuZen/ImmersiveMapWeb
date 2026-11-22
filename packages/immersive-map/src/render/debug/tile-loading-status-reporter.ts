// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TileLoaderStatusObserver, TileParseLayerTiming } from "../../tile/loading/tile-loader.ts";
import { type Tile, tileKey } from "../../tile/tile.ts";

/** One lane's counters (the Swift `TileLoadingPhaseSnapshot`). */
export interface TileLoadingPhaseSnapshot {
  readonly inFlight: number;
  readonly completed: number;
  readonly failed: number;
}

/** Where a tile's load stands (the Swift `TileLoadingTileStatus`). */
export type TileLoadingTileStatus = "queued" | "loading" | "parsing" | "ready" | "failed";

/** One stage a tile went through, with its duration in seconds, undefined for an instant stage (the Swift `TilePreparationStageSnapshot`). */
export interface TilePreparationStageSnapshot {
  readonly name: string;
  readonly duration: number | undefined;
  readonly layerTimings: readonly TileParseLayerTiming[];
}

/** One tile's row (the Swift `TileLoadingStatusTileSnapshot`). */
export interface TileLoadingStatusTileSnapshot {
  readonly tile: Tile;
  readonly status: TileLoadingTileStatus;
  /** 0 to 1. */
  readonly progress: number;
  readonly detail: string;
  readonly preparationStages: readonly TilePreparationStageSnapshot[];
  /**
   * How long the row has shown its current detail, in whole seconds, for a
   * record whose status is live work (`loading`, `parsing`), zero otherwise.
   * A stage that stays put grows old in the HUD instead of looking like it
   * started a moment ago.
   */
  readonly stageAgeSeconds: number;
}

/** The loader's state as the debug panel shows it (the Swift `TileLoadingStatusSnapshot`). */
export interface TileLoadingStatusSnapshot {
  readonly requested: number;
  readonly deduplicated: number;
  readonly activeLoads: number;
  readonly scheduled: number;
  readonly disk: TileLoadingPhaseSnapshot;
  readonly network: TileLoadingPhaseSnapshot;
  readonly parsing: TileLoadingPhaseSnapshot;
  readonly totalCompleted: number;
  readonly totalFailed: number;
  readonly networkBytes: number;
  readonly latestDiskTile: Tile | undefined;
  readonly latestNetworkTile: Tile | undefined;
  readonly latestParsingTile: Tile | undefined;
  readonly latestFailure: string | undefined;
  readonly latestParseLayerTimingTile: Tile | undefined;
  readonly latestParseLayerTimings: readonly TileParseLayerTiming[];
  readonly tiles: readonly TileLoadingStatusTileSnapshot[];
}

function tileDescription(tile: Tile): string {
  return `z${tile.z}/${tile.x}/${tile.y}`;
}

function sortedLayerTimings(timings: readonly TileParseLayerTiming[]): TileParseLayerTiming[] {
  return timings
    .filter((timing) => timing.duration > 0)
    .sort((lhs, rhs) => (lhs.duration !== rhs.duration ? rhs.duration - lhs.duration : lhs.layerName < rhs.layerName ? -1 : lhs.layerName > rhs.layerName ? 1 : 0));
}

function parseLayerTimingLine(tile: Tile | undefined, timings: readonly TileParseLayerTiming[]): string | undefined {
  if (tile === undefined || timings.length === 0) return undefined;
  const items = sortedLayerTimings(timings)
    .slice(0, 3)
    .map((timing) => `${timing.layerName} ${Math.round(timing.duration * 1000)}ms`);
  if (items.length === 0) return undefined;
  return `parse layers ${tileDescription(tile)}: ${items.join(", ")}`;
}

function sameTile(lhs: Tile | undefined, rhs: Tile | undefined): boolean {
  return lhs === rhs || (lhs !== undefined && rhs !== undefined && lhs.x === rhs.x && lhs.y === rhs.y && lhs.z === rhs.z);
}

function samePhase(lhs: TileLoadingPhaseSnapshot, rhs: TileLoadingPhaseSnapshot): boolean {
  return lhs.inFlight === rhs.inFlight && lhs.completed === rhs.completed && lhs.failed === rhs.failed;
}

function sameTimings(lhs: readonly TileParseLayerTiming[], rhs: readonly TileParseLayerTiming[]): boolean {
  return lhs.length === rhs.length && lhs.every((timing, index) => timing.layerName === rhs[index]!.layerName && timing.duration === rhs[index]!.duration);
}

function sameStages(lhs: readonly TilePreparationStageSnapshot[], rhs: readonly TilePreparationStageSnapshot[]): boolean {
  return (
    lhs.length === rhs.length &&
    lhs.every((stage, index) => {
      const other = rhs[index]!;
      return stage.name === other.name && stage.duration === other.duration && sameTimings(stage.layerTimings, other.layerTimings);
    })
  );
}

function sameRow(lhs: TileLoadingStatusTileSnapshot, rhs: TileLoadingStatusTileSnapshot): boolean {
  return (
    sameTile(lhs.tile, rhs.tile) &&
    lhs.status === rhs.status &&
    lhs.progress === rhs.progress &&
    lhs.detail === rhs.detail &&
    lhs.stageAgeSeconds === rhs.stageAgeSeconds &&
    sameStages(lhs.preparationStages, rhs.preparationStages)
  );
}

export const TileLoadingStatusSnapshot = {
  /** Nothing loaded, nothing asked: what the panel shows before the first frame. */
  empty: Object.freeze({
    requested: 0,
    deduplicated: 0,
    activeLoads: 0,
    scheduled: 0,
    disk: Object.freeze({ inFlight: 0, completed: 0, failed: 0 }),
    network: Object.freeze({ inFlight: 0, completed: 0, failed: 0 }),
    parsing: Object.freeze({ inFlight: 0, completed: 0, failed: 0 }),
    totalCompleted: 0,
    totalFailed: 0,
    networkBytes: 0,
    latestDiskTile: undefined,
    latestNetworkTile: undefined,
    latestParsingTile: undefined,
    latestFailure: undefined,
    latestParseLayerTimingTile: undefined,
    latestParseLayerTimings: Object.freeze([]),
    tiles: Object.freeze([]),
  }) as TileLoadingStatusSnapshot,

  /** The HUD's lines, one value a line so a reader finds the one they watch, none before the loader did anything. */
  lines(snapshot: TileLoadingStatusSnapshot): string[] {
    const s = snapshot;
    if (!(s.requested > 0 || s.activeLoads > 0 || s.scheduled > 0 || s.totalCompleted > 0 || s.totalFailed > 0)) return [];
    const output = [
      `requested:${s.requested}`,
      `deduplicated:${s.deduplicated}`,
      `active:${s.activeLoads}`,
      `scheduled:${s.scheduled}`,
      `disk in:${s.disk.inFlight}`,
      `disk hit:${s.disk.completed}`,
      `disk miss:${s.disk.failed}`,
      `network in:${s.network.inFlight}`,
      `network done:${s.network.completed}`,
      `network fail:${s.network.failed}`,
      `network bytes:${s.networkBytes}`,
      `parse in:${s.parsing.inFlight}`,
      `parse done:${s.parsing.completed}`,
      `parse fail:${s.parsing.failed}`,
      `total done:${s.totalCompleted}`,
      `total fail:${s.totalFailed}`,
    ];
    if (s.latestDiskTile) output.push(`current disk:${tileDescription(s.latestDiskTile)}`);
    if (s.latestNetworkTile) output.push(`current net:${tileDescription(s.latestNetworkTile)}`);
    if (s.latestParsingTile) output.push(`current parse:${tileDescription(s.latestParsingTile)}`);
    if (s.latestFailure !== undefined) output.push(`last failure: ${s.latestFailure}`);
    const timingLine = parseLayerTimingLine(s.latestParseLayerTimingTile, s.latestParseLayerTimings);
    if (timingLine !== undefined) output.push(timingLine);
    return output;
  },

  /** Structural equality, for the between-frames refresh that skips a snapshot nothing moved in. */
  equals(lhs: TileLoadingStatusSnapshot, rhs: TileLoadingStatusSnapshot): boolean {
    if (lhs === rhs) return true;
    return (
      lhs.requested === rhs.requested &&
      lhs.deduplicated === rhs.deduplicated &&
      lhs.activeLoads === rhs.activeLoads &&
      lhs.scheduled === rhs.scheduled &&
      samePhase(lhs.disk, rhs.disk) &&
      samePhase(lhs.network, rhs.network) &&
      samePhase(lhs.parsing, rhs.parsing) &&
      lhs.totalCompleted === rhs.totalCompleted &&
      lhs.totalFailed === rhs.totalFailed &&
      lhs.networkBytes === rhs.networkBytes &&
      sameTile(lhs.latestDiskTile, rhs.latestDiskTile) &&
      sameTile(lhs.latestNetworkTile, rhs.latestNetworkTile) &&
      sameTile(lhs.latestParsingTile, rhs.latestParsingTile) &&
      lhs.latestFailure === rhs.latestFailure &&
      sameTile(lhs.latestParseLayerTimingTile, rhs.latestParseLayerTimingTile) &&
      sameTimings(lhs.latestParseLayerTimings, rhs.latestParseLayerTimings) &&
      lhs.tiles.length === rhs.tiles.length &&
      lhs.tiles.every((row, index) => sameRow(row, rhs.tiles[index]!))
    );
  },
} as const;

interface PhaseCounters {
  inFlight: number;
  completed: number;
  failed: number;
}

interface TileRecord {
  readonly tile: Tile;
  status: TileLoadingTileStatus;
  progress: number;
  detail: string;
  preparationStages: TilePreparationStageSnapshot[];
  stageStartTimes: Map<string, number>;
  sequence: number;
  /** When `detail` last changed, for the row's stage age. */
  detailSince: number;
}

const maximumRecentPreparationStageCount = 256;

function isActiveResourceStatus(status: TileLoadingTileStatus): boolean {
  return status === "loading" || status === "parsing";
}

function priority(status: TileLoadingTileStatus): number {
  switch (status) {
    case "loading":
      return 0;
    case "parsing":
      return 1;
    case "queued":
      return 2;
    case "failed":
      return 3;
    case "ready":
      return 4;
  }
}

/**
 * What the loader is doing, tile by tile, for the debug panel (the Swift
 * `TileLoadingStatusReporter`). The loader calls it through its
 * `statusObserver`, the frame tells it which tiles are on screen
 * (`recordDisplayedTiles`). A row lives while its tile is in demand, on
 * screen or in live work. Everything runs on the main thread, so it holds
 * plain fields. Attached only while the debug panel is on.
 */
export class TileLoadingStatusReporter implements TileLoaderStatusObserver {
  /** Called after every change: the debug panel reads the rows again. Set and cleared by the engine. */
  onChange: (() => void) | undefined;

  readonly #now: () => number;
  #requested = 0;
  #deduplicated = 0;
  #activeLoads = 0;
  readonly #activeLoadTiles = new Set<string>();
  #scheduled = 0;
  readonly #disk: PhaseCounters = { inFlight: 0, completed: 0, failed: 0 };
  readonly #network: PhaseCounters = { inFlight: 0, completed: 0, failed: 0 };
  readonly #parsing: PhaseCounters = { inFlight: 0, completed: 0, failed: 0 };
  #totalCompleted = 0;
  #totalFailed = 0;
  #networkBytes = 0;
  readonly #activeDiskTiles = new Map<string, Tile>();
  readonly #activeNetworkTiles = new Map<string, Tile>();
  readonly #activeParsingTiles = new Map<string, Tile>();
  #latestDiskTile: Tile | undefined;
  #latestNetworkTile: Tile | undefined;
  #latestParsingTile: Tile | undefined;
  #latestFailure: string | undefined;
  #latestParseLayerTimingTile: Tile | undefined;
  #latestParseLayerTimings: readonly TileParseLayerTiming[] = [];
  #currentDemand = new Set<string>();
  #displayedTiles = new Set<string>();
  readonly #tileRecords = new Map<string, TileRecord>();
  readonly #recentPreparationStagesByTile = new Map<string, TilePreparationStageSnapshot[]>();
  #sequence = 0;

  /** `now` in seconds. */
  constructor(now: () => number = () => performance.now() / 1000) {
    this.#now = now;
  }

  recordDemand(input: number, deduplicated: number, tiles: readonly Tile[]): void {
    this.#requested = input;
    this.#deduplicated = deduplicated;
    this.#currentDemand = new Set(tiles.map(tileKey));
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  /** The tiles the frame drew. */
  recordDisplayedTiles(tiles: readonly Tile[]): void {
    this.#displayedTiles = new Set(tiles.map(tileKey));
    for (const tile of tiles) {
      if (!this.#shouldCreateDisplayedRecord(tile)) continue;
      this.#restoreRecentPreparationStages(tile);
      this.#updateTile(tile, "ready", 1, "displayed");
    }
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  recordLoadScheduled(tile: Tile): void {
    this.#scheduled += 1;
    this.#updateTile(tile, "queued", 0.1, "queued");
    this.onChange?.();
  }

  recordLoadStarted(tile: Tile): void {
    this.#activeLoadTiles.add(tileKey(tile));
    this.#activeLoads = this.#activeLoadTiles.size;
    this.#updateTile(tile, "loading", 0.35, "network");
    this.onChange?.();
  }

  recordLoadCompleted(tile: Tile): void {
    this.#activeLoadTiles.delete(tileKey(tile));
    this.#activeLoads = this.#activeLoadTiles.size;
    this.#totalCompleted += 1;
    this.#appendInstantStage("ready", tile);
    this.#storeRecentPreparationStages(tile);
    this.#updateTile(tile, "ready", 1, "ready");
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  recordLoadFailed(tile: Tile, reason: string): void {
    this.#activeLoadTiles.delete(tileKey(tile));
    this.#activeLoads = this.#activeLoadTiles.size;
    this.#totalFailed += 1;
    this.#latestFailure = reason;
    this.#updateTile(tile, "failed", 1, reason);
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  recordLoadsCancelled(tiles: readonly Tile[]): void {
    this.#requested = 0;
    this.#deduplicated = 0;
    this.#currentDemand.clear();
    for (const tile of tiles) {
      const key = tileKey(tile);
      this.#activeLoadTiles.delete(key);
      this.#activeDiskTiles.delete(key);
      this.#activeNetworkTiles.delete(key);
      this.#activeParsingTiles.delete(key);
    }
    this.#activeLoads = this.#activeLoadTiles.size;
    this.#disk.inFlight = this.#activeDiskTiles.size;
    this.#network.inFlight = this.#activeNetworkTiles.size;
    this.#parsing.inFlight = this.#activeParsingTiles.size;
    for (const tile of tiles) {
      const key = tileKey(tile);
      this.#tileRecords.delete(key);
      if (this.#displayedTiles.has(key)) this.#updateTile(tile, "ready", 1, "displayed");
    }
    this.#refreshLatestTiles();
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  /**
   * A load parked between stages was dropped because demand left the tile:
   * no failure, no completion, just bookkeeping so `activeLoads` does not
   * leak.
   */
  recordLoadDropped(tile: Tile): void {
    const key = tileKey(tile);
    this.#activeLoadTiles.delete(key);
    this.#activeLoads = this.#activeLoadTiles.size;
    this.#tileRecords.delete(key);
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  /**
   * The loader's watchdog retired the load: its stage held a lane slot past
   * the stage's deadline. The row says so, the phase it was in is closed,
   * and the failure counts like any other. A load that had already landed
   * (only its save was left) counts nothing.
   */
  recordLoadStalled(tile: Tile, stage: string, _ageSeconds = 0, landed = false): void {
    if (landed) return;
    this.#endActiveWork(tile);
    this.#totalFailed += 1;
    const reason = `stalled in ${stage}`;
    this.#latestFailure = reason;
    this.#updateTile(tile, "failed", 1, reason);
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  /**
   * The load's entry was dropped while the row still showed live work: no
   * completion, failure, cancellation or drop was recorded on the way out.
   * The row stops claiming a stage nobody is in.
   */
  recordLoadEnded(tile: Tile): void {
    const record = this.#tileRecords.get(tileKey(tile));
    if (!record || !isActiveResourceStatus(record.status)) return;
    this.#endActiveWork(tile);
    this.#updateTile(tile, "failed", 1, `ended in ${record.detail}`);
    this.#pruneInactiveStaleTiles();
    this.onChange?.();
  }

  recordDiskStarted(tile: Tile): void {
    this.#disk.inFlight += 1;
    this.#activeDiskTiles.set(tileKey(tile), tile);
    this.#latestDiskTile = tile;
    this.#startStage("disk", tile);
    this.#updateTile(tile, "loading", 0.2, "disk");
    this.onChange?.();
  }

  /** The prepared cache answered the load: the read and its materialize count as one served disk stage. */
  recordDiskServed(tile: Tile): void {
    if (!this.#activeDiskTiles.delete(tileKey(tile))) return;
    this.#disk.inFlight = Math.max(0, this.#disk.inFlight - 1);
    this.#disk.completed += 1;
    this.#finishStage("disk", tile);
    this.#updateTile(tile, "loading", 0.3, "disk hit");
    this.#latestDiskTile = this.#latestActiveTile(this.#activeDiskTiles);
    this.onChange?.();
  }

  /** The disk could not answer: the load continues to the network stage. */
  recordDiskMissed(tile: Tile): void {
    if (!this.#activeDiskTiles.delete(tileKey(tile))) return;
    this.#disk.inFlight = Math.max(0, this.#disk.inFlight - 1);
    this.#disk.failed += 1;
    this.#finishStage("disk", tile);
    this.#updateTile(tile, "queued", 0.25, "disk miss");
    this.#latestDiskTile = this.#latestActiveTile(this.#activeDiskTiles);
    this.onChange?.();
  }

  recordNetworkStarted(tile: Tile): void {
    this.#network.inFlight += 1;
    this.#activeNetworkTiles.set(tileKey(tile), tile);
    this.#latestNetworkTile = tile;
    this.#startStage("network", tile);
    this.#updateTile(tile, "loading", 0.35, "network");
    this.onChange?.();
  }

  recordNetworkSucceeded(tile: Tile, bytes: number): void {
    this.#network.inFlight = Math.max(0, this.#network.inFlight - 1);
    this.#network.completed += 1;
    this.#networkBytes += bytes;
    this.#activeNetworkTiles.delete(tileKey(tile));
    this.#finishStage("network", tile);
    this.#updateTile(tile, "loading", 0.55, `${bytes} bytes`);
    this.#latestNetworkTile = this.#latestActiveTile(this.#activeNetworkTiles);
    this.onChange?.();
  }

  recordNetworkFailed(tile: Tile, reason: string): void {
    this.#network.inFlight = Math.max(0, this.#network.inFlight - 1);
    this.#network.failed += 1;
    this.#activeNetworkTiles.delete(tileKey(tile));
    this.#latestFailure = reason;
    this.#finishStage("network", tile);
    this.#updateTile(tile, "failed", 1, reason);
    this.#latestNetworkTile = this.#latestActiveTile(this.#activeNetworkTiles);
    this.onChange?.();
  }

  recordParsingStarted(tile: Tile): void {
    this.#parsing.inFlight += 1;
    this.#activeParsingTiles.set(tileKey(tile), tile);
    this.#latestParsingTile = tile;
    this.#startStage("parse", tile);
    this.#updateTile(tile, "parsing", 0.7, "parse");
    this.onChange?.();
  }

  recordParsingSucceeded(tile: Tile, layerTimings: readonly TileParseLayerTiming[] = []): void {
    this.#parsing.inFlight = Math.max(0, this.#parsing.inFlight - 1);
    this.#parsing.completed += 1;
    this.#activeParsingTiles.delete(tileKey(tile));
    this.#latestParseLayerTimingTile = tile;
    this.#latestParseLayerTimings = sortedLayerTimings(layerTimings);
    this.#finishStage("parse", tile, this.#latestParseLayerTimings);
    this.#updateTile(tile, "parsing", 0.85, "materialize");
    this.#latestParsingTile = this.#latestActiveTile(this.#activeParsingTiles);
    this.onChange?.();
  }

  recordParsingFailed(tile: Tile, reason: string): void {
    this.#parsing.inFlight = Math.max(0, this.#parsing.inFlight - 1);
    this.#parsing.failed += 1;
    this.#activeParsingTiles.delete(tileKey(tile));
    this.#latestFailure = reason;
    this.#finishStage("parse", tile);
    this.#updateTile(tile, "failed", 1, reason);
    this.#latestParsingTile = this.#latestActiveTile(this.#activeParsingTiles);
    this.onChange?.();
  }

  recordMaterializationStarted(tile: Tile): void {
    this.#startStage("materialize", tile);
    this.#updateTile(tile, "parsing", 0.9, "materialize");
    this.onChange?.();
  }

  recordMaterializationSucceeded(tile: Tile): void {
    this.#finishStage("materialize", tile);
    this.#updateTile(tile, "parsing", 0.95, "materialized");
    this.onChange?.();
  }

  recordMaterializationFailed(tile: Tile, reason: string): void {
    this.#finishStage("materialize", tile);
    this.#updateTile(tile, "parsing", 0.95, reason);
    this.onChange?.();
  }

  snapshot(): TileLoadingStatusSnapshot {
    const time = this.#now();
    const rows: TileRecord[] = [];
    for (const [key, record] of this.#tileRecords) if (this.#shouldIncludeTile(key, record)) rows.push(record);
    rows.sort((lhs, rhs) => {
      const lhsPriority = priority(lhs.status);
      const rhsPriority = priority(rhs.status);
      if (lhsPriority !== rhsPriority) return lhsPriority - rhsPriority;
      if (lhs.sequence !== rhs.sequence) return rhs.sequence - lhs.sequence;
      if (lhs.tile.z !== rhs.tile.z) return rhs.tile.z - lhs.tile.z;
      if (lhs.tile.x !== rhs.tile.x) return lhs.tile.x - rhs.tile.x;
      return lhs.tile.y - rhs.tile.y;
    });
    const tiles = rows.map(
      (record): TileLoadingStatusTileSnapshot => ({
        tile: record.tile,
        status: record.status,
        progress: record.progress,
        detail: record.detail,
        preparationStages: [...record.preparationStages],
        stageAgeSeconds: isActiveResourceStatus(record.status) ? Math.trunc(Math.max(0, time - record.detailSince)) : 0,
      }),
    );
    return {
      requested: this.#requested,
      deduplicated: this.#deduplicated,
      activeLoads: this.#activeLoads,
      scheduled: this.#scheduled,
      disk: { ...this.#disk },
      network: { ...this.#network },
      parsing: { ...this.#parsing },
      totalCompleted: this.#totalCompleted,
      totalFailed: this.#totalFailed,
      networkBytes: this.#networkBytes,
      latestDiskTile: this.#latestDiskTile,
      latestNetworkTile: this.#latestNetworkTile,
      latestParsingTile: this.#latestParsingTile,
      latestFailure: this.#latestFailure,
      latestParseLayerTimingTile: this.#latestParseLayerTimingTile,
      latestParseLayerTimings: this.#latestParseLayerTimings,
      tiles,
    };
  }

  /** Takes the tile out of every live set and closes the phase it was in, for the stalled and ended exits. */
  #endActiveWork(tile: Tile): void {
    const key = tileKey(tile);
    this.#activeLoadTiles.delete(key);
    this.#activeLoads = this.#activeLoadTiles.size;
    if (this.#activeDiskTiles.delete(key)) {
      this.#disk.inFlight = this.#activeDiskTiles.size;
      this.#finishStage("disk", tile);
    }
    if (this.#activeNetworkTiles.delete(key)) {
      this.#network.inFlight = this.#activeNetworkTiles.size;
      this.#finishStage("network", tile);
    }
    if (this.#activeParsingTiles.delete(key)) {
      this.#parsing.inFlight = this.#activeParsingTiles.size;
      this.#finishStage("parse", tile);
    }
    this.#refreshLatestTiles();
  }

  #newRecord(tile: Tile, status: TileLoadingTileStatus, progress: number, detail: string, sequence: number): TileRecord {
    return { tile, status, progress, detail, preparationStages: [], stageStartTimes: new Map(), sequence, detailSince: this.#now() };
  }

  #record(tile: Tile): TileRecord {
    const key = tileKey(tile);
    let record = this.#tileRecords.get(key);
    if (!record) {
      record = this.#newRecord(tile, "queued", 0.1, "queued", this.#sequence);
      this.#tileRecords.set(key, record);
    }
    return record;
  }

  #updateTile(tile: Tile, status: TileLoadingTileStatus, progress: number, detail: string): void {
    this.#sequence += 1;
    const key = tileKey(tile);
    const time = this.#now();
    let record = this.#tileRecords.get(key);
    if (!record) {
      record = this.#newRecord(tile, status, progress, detail, this.#sequence);
      this.#tileRecords.set(key, record);
    }
    if (record.detail !== detail || record.status !== status) record.detailSince = time;
    record.status = status;
    record.progress = Math.min(Math.max(progress, 0), 1);
    record.detail = detail;
    record.sequence = this.#sequence;
  }

  #startStage(name: string, tile: Tile): void {
    this.#record(tile).stageStartTimes.set(name, this.#now());
  }

  #finishStage(name: string, tile: Tile, layerTimings: readonly TileParseLayerTiming[] = []): void {
    const record = this.#record(tile);
    const startedAt = record.stageStartTimes.get(name);
    record.stageStartTimes.delete(name);
    const duration = startedAt === undefined ? undefined : Math.max(0, this.#now() - startedAt);
    record.preparationStages = record.preparationStages.filter((stage) => stage.name !== name);
    record.preparationStages.push({ name, duration, layerTimings });
  }

  #appendInstantStage(name: string, tile: Tile): void {
    const record = this.#record(tile);
    record.preparationStages = record.preparationStages.filter((stage) => stage.name !== name);
    record.preparationStages.push({ name, duration: undefined, layerTimings: [] });
  }

  #storeRecentPreparationStages(tile: Tile): void {
    const key = tileKey(tile);
    const stages = this.#tileRecords.get(key)?.preparationStages;
    if (!stages || stages.length === 0) return;
    this.#recentPreparationStagesByTile.set(key, stages);
    this.#pruneRecentPreparationStages();
  }

  #restoreRecentPreparationStages(tile: Tile): void {
    const key = tileKey(tile);
    const stages = this.#recentPreparationStagesByTile.get(key);
    if (!stages || stages.length === 0) return;
    let record = this.#tileRecords.get(key);
    if (!record) {
      record = this.#newRecord(tile, "ready", 1, "displayed", this.#sequence);
      this.#tileRecords.set(key, record);
    }
    record.preparationStages = [...stages];
  }

  #pruneRecentPreparationStages(): void {
    if (this.#recentPreparationStagesByTile.size <= maximumRecentPreparationStageCount) return;
    for (const key of [...this.#recentPreparationStagesByTile.keys()]) {
      const retained =
        this.#currentDemand.has(key) ||
        this.#displayedTiles.has(key) ||
        this.#activeDiskTiles.has(key) ||
        this.#activeNetworkTiles.has(key) ||
        this.#activeParsingTiles.has(key);
      if (!retained) this.#recentPreparationStagesByTile.delete(key);
    }
  }

  #pruneInactiveStaleTiles(): void {
    for (const [key, record] of this.#tileRecords) if (!this.#shouldIncludeTile(key, record)) this.#tileRecords.delete(key);
  }

  #refreshLatestTiles(): void {
    this.#latestDiskTile = this.#latestActiveTile(this.#activeDiskTiles);
    this.#latestNetworkTile = this.#latestActiveTile(this.#activeNetworkTiles);
    this.#latestParsingTile = this.#latestActiveTile(this.#activeParsingTiles);
  }

  /** The live tile touched last, ties to the deeper zoom, then the lower x, then the lower y. */
  #latestActiveTile(tiles: ReadonlyMap<string, Tile>): Tile | undefined {
    let best: Tile | undefined;
    let bestSequence = 0;
    for (const [key, tile] of tiles) {
      const sequence = this.#tileRecords.get(key)?.sequence ?? 0;
      if (best === undefined) {
        best = tile;
        bestSequence = sequence;
        continue;
      }
      const isLess =
        bestSequence !== sequence ? bestSequence < sequence : best.z !== tile.z ? best.z < tile.z : best.x !== tile.x ? best.x > tile.x : best.y > tile.y;
      if (isLess) {
        best = tile;
        bestSequence = sequence;
      }
    }
    return best;
  }

  #shouldIncludeTile(key: string, record: TileRecord): boolean {
    return this.#currentDemand.has(key) || this.#displayedTiles.has(key) || isActiveResourceStatus(record.status);
  }

  #shouldCreateDisplayedRecord(tile: Tile): boolean {
    const record = this.#tileRecords.get(tileKey(tile));
    return !record || !isActiveResourceStatus(record.status);
  }
}
