// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TileLoaderStatusObserver, TileParseLayerTiming } from "../../tile/loading/tile-loader.ts";
import { type Tile, tileKey } from "../../tile/tile.ts";
import { JSONLinesTrace, type TraceEvent, type TraceFieldValue, type TraceRecorderOptions, type TraceRecorderSnapshot } from "./json-lines-trace.ts";
import type { TileLoadingStatusSnapshot, TileLoadingStatusTileSnapshot } from "./tile-loading-status-reporter.ts";

/** Whether the tile trace records and the file name of the current or last one (the Swift `TileTraceRecorderSnapshot`). */
export type TileTraceRecorderSnapshot = TraceRecorderSnapshot;

/** One tile trace line (the Swift `TileTraceEvent`). */
export type TileTraceEvent = TraceEvent;

const sensitiveQueryNames = new Set(["access_token", "apikey", "api_key", "authorization", "auth", "key", "password", "token"]);

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * A URL with the values of its secret query items replaced by `REDACTED`
 * (the Swift `TileTraceURLRedactor`), everything else as written.
 */
export function redactTraceURL(value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart < 0) return value;
  const fragmentStart = value.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const query = value.slice(queryStart + 1, queryEnd);
  if (query.length === 0) return value;
  const items = query.split("&").map((item) => {
    const equals = item.indexOf("=");
    const name = equals < 0 ? item : item.slice(0, equals);
    return sensitiveQueryNames.has(decodedName(name).toLowerCase()) ? `${name}=REDACTED` : item;
  });
  return `${value.slice(0, queryStart + 1)}${items.join("&")}${value.slice(queryEnd)}`;
}

function event(name: string, fields: Record<string, TraceFieldValue> = {}, frameIndex?: number): TileTraceEvent {
  return { name, frameIndex, fields };
}

function parseLayerTimingsDescription(timings: readonly TileParseLayerTiming[]): string {
  return timings
    .filter((timing) => timing.duration > 0)
    .sort((lhs, rhs) => (lhs.duration !== rhs.duration ? rhs.duration - lhs.duration : lhs.layerName < rhs.layerName ? -1 : lhs.layerName > rhs.layerName ? 1 : 0))
    .map((timing) => `${timing.layerName}:${Math.round(timing.duration * 1000)}ms`)
    .join(",");
}

function tileStatusDescription(tiles: readonly TileLoadingStatusTileSnapshot[]): string {
  return tiles.map((row) => `${tileKey(row.tile)}:${row.status}:${row.detail}`).join(";");
}

/** The tile trace's events, with the Swift names and fields. Tiles are written as `z/x/y`. */
export const TileTraceEvent = {
  event(name: string, frameIndex?: number, fields: Record<string, TraceFieldValue> = {}): TileTraceEvent {
    return event(name, fields, frameIndex);
  },

  /** A URL field's value, redacted. */
  url(value: string): string {
    return redactTraceURL(value);
  },

  tileStoreRequest(frameIndex: number | undefined, demanded: number, ready: number, requested: number): TileTraceEvent {
    return event("tile_store_request", { demanded, ready, requested }, frameIndex);
  },

  tilePrepareStart(tile: Tile): TileTraceEvent {
    return event("tile_prepare_start", { tile: tileKey(tile) });
  },

  tilePrepareSuccess(tile: Tile, layerTimings: readonly TileParseLayerTiming[] = []): TileTraceEvent {
    const fields: Record<string, TraceFieldValue> = { tile: tileKey(tile) };
    const timings = parseLayerTimingsDescription(layerTimings);
    if (timings.length > 0) fields["parseLayerTimings"] = timings;
    return event("tile_prepare_success", fields);
  },

  tilePrepareFailed(tile: Tile, error: unknown): TileTraceEvent {
    return event("tile_prepare_failed", { tile: tileKey(tile), error: String(error) });
  },

  tileMaterializeStart(tile: Tile): TileTraceEvent {
    return event("tile_materialize_start", { tile: tileKey(tile) });
  },

  tileMaterializeSuccess(tile: Tile): TileTraceEvent {
    return event("tile_materialize_success", { tile: tileKey(tile) });
  },

  tileMaterializeFailed(tile: Tile): TileTraceEvent {
    return event("tile_materialize_failed", { tile: tileKey(tile) });
  },

  tileStoreLookup(tile: Tile, hit: boolean, residentCount: number, residentBytes: number): TileTraceEvent {
    return event("tile_store_lookup", { tile: tileKey(tile), hit, residentCount, residentBytes });
  },

  tileStoreInsert(tile: Tile, replaced: boolean, residentCount: number, residentBytes: number): TileTraceEvent {
    return event("tile_store_insert", { tile: tileKey(tile), replaced, residentCount, residentBytes });
  },

  tileStoreRelease(tile: Tile, reason: string, residentCount: number, residentBytes: number): TileTraceEvent {
    return event("tile_store_release", { tile: tileKey(tile), reason, residentCount, residentBytes });
  },

  tileStoreRemoveAll(removedCount: number, removedBytes: number): TileTraceEvent {
    return event("tile_store_remove_all", { removedCount, removedBytes });
  },

  tileSchedulerRequest(input: number, deduplicated: number): TileTraceEvent {
    return event("tile_scheduler_request", { input, deduplicated });
  },

  tileSchedulerAlreadyLoading(tile: Tile): TileTraceEvent {
    return event("tile_scheduler_already_loading", { tile: tileKey(tile) });
  },

  tileSchedulerRetryBlocked(tile: Tile): TileTraceEvent {
    return event("tile_scheduler_retry_blocked", { tile: tileKey(tile) });
  },

  tileSchedulerEnqueued(tile: Tile, inFlight: number): TileTraceEvent {
    return event("tile_scheduler_enqueued", { tile: tileKey(tile), inFlight });
  },

  tileLoadScheduled(tile: Tile, inFlight: number): TileTraceEvent {
    return event("tile_load_scheduled", { tile: tileKey(tile), inFlight });
  },

  tileLoadStart(tile: Tile): TileTraceEvent {
    return event("tile_load_start", { tile: tileKey(tile) });
  },

  tileLoadDropped(tile: Tile): TileTraceEvent {
    return event("tile_load_dropped", { tile: tileKey(tile) });
  },

  tileDiskLookupStart(tile: Tile): TileTraceEvent {
    return event("tile_disk_lookup_start", { tile: tileKey(tile) });
  },

  tileDiskHit(tile: Tile): TileTraceEvent {
    return event("tile_disk_hit", { tile: tileKey(tile) });
  },

  tileDiskMiss(tile: Tile, reason: string): TileTraceEvent {
    return event("tile_disk_miss", { tile: tileKey(tile), reason });
  },

  tileDownloadSuccess(tile: Tile, bytes: number): TileTraceEvent {
    return event("tile_download_success", { tile: tileKey(tile), bytes });
  },

  tileDownloadFailed(tile: Tile, reason: string): TileTraceEvent {
    return event("tile_download_failed", { tile: tileKey(tile), reason });
  },

  tileLoadSuccess(tile: Tile, source: string): TileTraceEvent {
    return event("tile_load_success", { tile: tileKey(tile), source });
  },

  tileLoadFailed(tile: Tile, reason: string): TileTraceEvent {
    return event("tile_load_failed", { tile: tileKey(tile), reason });
  },

  /** `age` in seconds. */
  tileLoadStalled(tile: Tile, stage: string, age: number): TileTraceEvent {
    return event("tile_load_stalled", { tile: tileKey(tile), stage, ageSeconds: age });
  },

  tileDemandUpdate(update: {
    readonly frameIndex: number;
    readonly visible: number;
    readonly demanded: number;
    readonly ready: number;
    readonly requested: number;
    readonly rendered: number;
    readonly placementChanged: boolean;
    readonly placementVersion: number;
    readonly surface: string;
    readonly inOwnSlot: number;
    readonly standIns: number;
  }): TileTraceEvent {
    const { frameIndex, ...fields } = update;
    return event("tile_demand_update", fields, frameIndex);
  },

  tileLoadingStatusSnapshot(frameIndex: number, snapshot: TileLoadingStatusSnapshot): TileTraceEvent {
    const fields: Record<string, TraceFieldValue> = {
      requested: snapshot.requested,
      deduplicated: snapshot.deduplicated,
      activeLoads: snapshot.activeLoads,
      scheduled: snapshot.scheduled,
      diskInFlight: snapshot.disk.inFlight,
      diskCompleted: snapshot.disk.completed,
      diskFailed: snapshot.disk.failed,
      networkInFlight: snapshot.network.inFlight,
      networkCompleted: snapshot.network.completed,
      networkFailed: snapshot.network.failed,
      parseInFlight: snapshot.parsing.inFlight,
      parseCompleted: snapshot.parsing.completed,
      parseFailed: snapshot.parsing.failed,
      totalCompleted: snapshot.totalCompleted,
      totalFailed: snapshot.totalFailed,
      networkBytes: snapshot.networkBytes,
    };
    if (snapshot.latestDiskTile) fields["latestDiskTile"] = tileKey(snapshot.latestDiskTile);
    if (snapshot.latestNetworkTile) fields["latestNetworkTile"] = tileKey(snapshot.latestNetworkTile);
    if (snapshot.latestParsingTile) fields["latestParsingTile"] = tileKey(snapshot.latestParsingTile);
    if (snapshot.latestFailure !== undefined) fields["latestFailure"] = snapshot.latestFailure;
    const tiles = tileStatusDescription(snapshot.tiles);
    if (tiles.length > 0) fields["tiles"] = tiles;
    return event("tile_loading_status_snapshot", fields, frameIndex);
  },
} as const;

/**
 * The tile trace (the Swift `TileTraceRecorder`): JSON Lines of the loader's
 * and the store's steps while the debug panel records. A recording lives in
 * memory, `takeBlob` hands the finished one to the panel to download under
 * the snapshot's file name. Every call while not recording returns at once.
 */
export class TileTraceRecorder {
  readonly #trace: JSONLinesTrace;

  constructor(options: TraceRecorderOptions = {}) {
    this.#trace = new JSONLinesTrace("immersive-map-tile-trace-", options);
  }

  get isRecording(): boolean {
    return this.#trace.isRecording;
  }

  /** Events dropped past the recording's size bound. */
  get droppedEventCount(): number {
    return this.#trace.droppedEventCount;
  }

  /** Starts a recording and returns its file name (`immersive-map-tile-trace-<UTC time>.jsonl`). */
  startRecording(): string {
    return this.#trace.startRecording();
  }

  stopRecording(): void {
    this.#trace.stopRecording();
  }

  snapshot(): TileTraceRecorderSnapshot {
    return this.#trace.snapshot();
  }

  record(event: TileTraceEvent): void {
    this.#trace.record(event);
  }

  /** The finished recording as JSON Lines, once. */
  takeBlob(): Blob | undefined {
    return this.#trace.takeBlob();
  }
}

/**
 * The loader's status observer that writes the tile trace's loader events
 * (the Swift `ImmersiveMapNeedsTile`'s `tileTraceRecorder.record` calls) and
 * hands every call on to `next`, the status reporter, so the loader keeps
 * one observer for both.
 */
export class TileTraceLoaderObserver implements TileLoaderStatusObserver {
  constructor(
    readonly recorder: TileTraceRecorder,
    readonly next: TileLoaderStatusObserver | undefined = undefined,
  ) {}

  recordDemand(input: number, deduplicated: number, tiles: readonly Tile[]): void {
    this.next?.recordDemand(input, deduplicated, tiles);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileSchedulerRequest(input, deduplicated));
  }

  recordSchedulerAlreadyLoading(tile: Tile): void {
    this.next?.recordSchedulerAlreadyLoading?.(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileSchedulerAlreadyLoading(tile));
  }

  recordSchedulerRetryBlocked(tile: Tile): void {
    this.next?.recordSchedulerRetryBlocked?.(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileSchedulerRetryBlocked(tile));
  }

  recordSchedulerEnqueued(tile: Tile, inFlight: number): void {
    this.next?.recordSchedulerEnqueued?.(tile, inFlight);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileSchedulerEnqueued(tile, inFlight));
  }

  recordLoadScheduled(tile: Tile, inFlight: number): void {
    this.next?.recordLoadScheduled(tile, inFlight);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileLoadScheduled(tile, inFlight));
  }

  recordLoadStarted(tile: Tile, entry: boolean): void {
    this.next?.recordLoadStarted(tile, entry);
    if (entry && this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileLoadStart(tile));
  }

  recordLoadCompleted(tile: Tile, source: string): void {
    this.next?.recordLoadCompleted(tile, source);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileLoadSuccess(tile, source));
  }

  recordLoadFailed(tile: Tile, reason: string): void {
    this.next?.recordLoadFailed(tile, reason);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileLoadFailed(tile, reason));
  }

  recordLoadsCancelled(tiles: readonly Tile[]): void {
    this.next?.recordLoadsCancelled(tiles);
  }

  recordLoadDropped(tile: Tile): void {
    this.next?.recordLoadDropped(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileLoadDropped(tile));
  }

  recordLoadStalled(tile: Tile, stage: string, ageSeconds: number, landed: boolean): void {
    this.next?.recordLoadStalled(tile, stage, ageSeconds, landed);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileLoadStalled(tile, stage, ageSeconds));
  }

  recordLoadEnded(tile: Tile): void {
    this.next?.recordLoadEnded(tile);
  }

  recordDiskStarted(tile: Tile): void {
    this.next?.recordDiskStarted(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileDiskLookupStart(tile));
  }

  recordDiskServed(tile: Tile): void {
    this.next?.recordDiskServed(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileDiskHit(tile));
  }

  recordDiskMissed(tile: Tile, reason: string): void {
    this.next?.recordDiskMissed(tile, reason);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileDiskMiss(tile, reason));
  }

  recordNetworkStarted(tile: Tile): void {
    this.next?.recordNetworkStarted(tile);
  }

  recordNetworkSucceeded(tile: Tile, bytes: number): void {
    this.next?.recordNetworkSucceeded(tile, bytes);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileDownloadSuccess(tile, bytes));
  }

  recordNetworkFailed(tile: Tile, reason: string): void {
    this.next?.recordNetworkFailed(tile, reason);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileDownloadFailed(tile, reason));
  }

  recordParsingStarted(tile: Tile): void {
    this.next?.recordParsingStarted(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tilePrepareStart(tile));
  }

  recordParsingSucceeded(tile: Tile, layerTimings: readonly TileParseLayerTiming[]): void {
    this.next?.recordParsingSucceeded(tile, layerTimings);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tilePrepareSuccess(tile, layerTimings));
  }

  recordParsingFailed(tile: Tile, reason: string): void {
    this.next?.recordParsingFailed(tile, reason);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tilePrepareFailed(tile, reason));
  }

  recordMaterializationStarted(tile: Tile): void {
    this.next?.recordMaterializationStarted(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileMaterializeStart(tile));
  }

  recordMaterializationSucceeded(tile: Tile): void {
    this.next?.recordMaterializationSucceeded(tile);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileMaterializeSuccess(tile));
  }

  recordMaterializationFailed(tile: Tile, reason: string): void {
    this.next?.recordMaterializationFailed(tile, reason);
    if (this.recorder.isRecording) this.recorder.record(TileTraceEvent.tileMaterializeFailed(tile));
  }
}
