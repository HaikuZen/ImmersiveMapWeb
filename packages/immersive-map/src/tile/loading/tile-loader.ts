// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The tile loading orchestrator, a port of the Swift `ImmersiveMapNeedsTile`.
 *
 * Accepts the up-to-date set of needed tiles, puts deferred requests into a
 * deduplicated FIFO and drives each tile through three stages with
 * independent concurrency limits: a disk stage (the prepared cache answers
 * without the network), a network stage (the download) and a CPU stage (the
 * parse, then the hand-off to the GPU and the disk save). Disk reads are not
 * gated by network slots, a slow network does not occupy parse slots, and a
 * long parse does not block download starts.
 *
 * In the browser the stages run in the tile workers: this class only holds
 * the lanes, the priorities, the retry state and the watchdog, on the main
 * thread, and asks its `TileLoadPipeline` to do each stage.
 *
 * A disk hit is final: freshness comes from the prepared cache's identity and
 * TTL, so a served tile ends its load without a request. Only a miss, or an
 * entry that cannot be materialized, continues to the network. Every stage
 * that holds a lane slot has a deadline: a load whose stage outlives it is
 * retired by the watchdog (the slot freed, a stalled failure recorded, the
 * retry backoff armed and the renderer woken), so no answer that never comes
 * can hold a slot or hide a hole on the map for good.
 */

import { type DownloadFailure, downloadFailureDescription, retryFailureDescription, type TileRetryFailureReason } from "./download-failure.ts";
import { DeduplicatedTilesFIFO } from "./deduplicated-fifo.ts";
import { defaultRetryPolicy, type RetryPolicy, TileRetryController } from "./retry-controller.ts";
import { type Tile, tileKey } from "../tile.ts";

/**
 * What a download stage hands to the CPU stage: an opaque handle to bytes
 * kept where they were fetched, and their size when the pipeline knows it
 * (read only by a status observer).
 */
export type DownloadOutcome<Handle> = { ok: true; handle: Handle; etag: string | undefined; bytes?: number } | { ok: false; failure: DownloadFailure };

/** The outcome of turning prepared data into GPU state. */
export type MaterializeOutcome = "materialized" | "imageUnreadable" | "allocationOrStoreFailed";

export type PrepareOutcome = { ok: true; materialize: MaterializeOutcome } | { ok: false; reason: "parseFailed" };

/**
 * The stages the loader drives, each cancellable by its signal. The worker
 * pool implements it: the disk read, the download and the parse run in a
 * worker, the materialize (the GPU upload into the render store) on the main
 * thread inside the outcome it returns.
 */
export interface TileLoadPipeline<Handle> {
  readonly hasPreparedDiskCache: boolean;
  /** Whether the tile would come back from disk without a request. Cheap: asked per frame. */
  isPreparedOnDisk(tile: Tile): boolean;
  /** A disk hit, materialized, or `undefined` for a miss. */
  readDisk(tile: Tile, signal: AbortSignal): Promise<MaterializeOutcome | undefined>;
  /** Removes a disk entry that could not be materialized. */
  removeDiskEntry(tile: Tile): void;
  download(tile: Tile, signal: AbortSignal): Promise<DownloadOutcome<Handle>>;
  /**
   * The CPU stage: the prepared cache by the exact ETag, else the parse,
   * then the materialize and the disk save. `onParsed`, passed only while a
   * status observer is attached, is called between the parse and the
   * materialize, so the two stages are timed apart.
   */
  prepare(
    tile: Tile,
    download: { handle: Handle; etag: string | undefined },
    signal: AbortSignal,
    onParsed?: (layerTimings: readonly TileParseLayerTiming[]) => void,
  ): Promise<PrepareOutcome>;
  /** Drops what a download kept, when its CPU stage will never run. */
  releaseDownload(handle: Handle): void;
}

/** How long the parse spent on one source layer, in seconds (the Swift `TileParseLayerTiming`). */
export interface TileParseLayerTiming {
  readonly layerName: string;
  readonly duration: number;
}

/**
 * Who hears every step of every load, for the debug panel's tile rows and
 * the tile trace (the calls of the Swift `ImmersiveMapNeedsTile` into its
 * `TileLoadingStatusReporter` and its `TileTraceRecorder`). Called on the
 * main thread, only for the load's current generation, in the order the
 * steps happen. The loader behaves the same with or without one.
 */
export interface TileLoaderStatusObserver {
  recordDemand(input: number, deduplicated: number, tiles: readonly Tile[]): void;
  /** The tile was already in flight when demand named it. */
  recordSchedulerAlreadyLoading?(tile: Tile): void;
  /** The retry backoff kept the tile back. */
  recordSchedulerRetryBlocked?(tile: Tile): void;
  /** The entry lane was full: the tile waits in the pending queue. */
  recordSchedulerEnqueued?(tile: Tile, inFlight: number): void;
  /** A load was created, `inFlight` its entry lane's count with it. */
  recordLoadScheduled(tile: Tile, inFlight: number): void;
  /** `entry` is true for the load's first stage, false for the network stage that follows a disk miss. */
  recordLoadStarted(tile: Tile, entry: boolean): void;
  /** `source` is `prepared_disk` or `network`. */
  recordLoadCompleted(tile: Tile, source: string): void;
  recordLoadFailed(tile: Tile, reason: string): void;
  recordLoadsCancelled(tiles: readonly Tile[]): void;
  /** Parked work dropped because demand left the tile. */
  recordLoadDropped(tile: Tile): void;
  /** The watchdog retired the load. `landed` loads were only saving, and count no failure. */
  recordLoadStalled(tile: Tile, stage: string, ageSeconds: number, landed: boolean): void;
  /** The load's entry was dropped, whatever the outcome. */
  recordLoadEnded(tile: Tile): void;
  recordDiskStarted(tile: Tile): void;
  recordDiskServed(tile: Tile): void;
  /** `reason` is `no_entry`, `image_unreadable`, `materialize_failed` or `read_failed`. */
  recordDiskMissed(tile: Tile, reason: string): void;
  recordNetworkStarted(tile: Tile): void;
  recordNetworkSucceeded(tile: Tile, bytes: number): void;
  recordNetworkFailed(tile: Tile, reason: string): void;
  recordParsingStarted(tile: Tile): void;
  recordParsingSucceeded(tile: Tile, layerTimings: readonly TileParseLayerTiming[]): void;
  recordParsingFailed(tile: Tile, reason: string): void;
  recordMaterializationStarted(tile: Tile): void;
  recordMaterializationSucceeded(tile: Tile): void;
  recordMaterializationFailed(tile: Tile, reason: string): void;
}

export interface StageDeadlines {
  disk: number;
  network: number;
  cpu: number;
}

/**
 * Generous: a parse of the largest tile takes a couple of seconds, a disk hit
 * tens of milliseconds, and the network is bounded by the fetch's own
 * timeouts well inside its deadline.
 */
export const defaultStageDeadlines: Readonly<StageDeadlines> = { disk: 20, network: 90, cpu: 60 };

export interface TileLoaderOptions {
  maxConcurrentFetches: number;
  pendingRequestQueueCapacity: number;
  maxConcurrentPrepares: number;
  maxConcurrentDiskLoads: number;
  retryPolicy?: Readonly<RetryPolicy>;
  stageDeadlines?: Readonly<StageDeadlines>;
  /** Seconds. */
  now?: () => number;
  /** Schedules a wake after `delay` seconds and returns a cancel function. */
  scheduleWake?: (delay: number, wake: () => void) => () => void;
}

/** Default disk-stage limit: half the cores, two to four. */
export const defaultMaxConcurrentDiskLoads = Math.max(2, Math.min(Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2), 4));

type LoadStage = "disk" | "networkQueued" | "network" | "cpuQueued" | "cpu";

interface OngoingTask {
  tile: Tile;
  generation: number;
  controller: AbortController;
  stage: LoadStage;
  /** When `stage` was entered: the watchdog's clock for the stage. */
  stageStartedAt: number;
  /** The tile is on screen: what is left is its disk save. */
  landed: boolean;
  /** Demand named the tile again after it landed: the end of the load asks for a frame. */
  demandReturned: boolean;
}

interface QueuedCPUWork<Handle> {
  tile: Tile;
  generation: number;
  download: { handle: Handle; etag: string | undefined };
}

export interface TileLoaderEvents {
  /** The load of a tile ended, whatever the outcome. */
  onLoadEnded?: (tile: Tile) => void;
  onLoadFailed?: (tile: Tile, reason: TileRetryFailureReason) => void;
}

export class TileLoader<Handle> {
  /**
   * Called when the loader needs a frame to make progress: a retry window
   * expired, the watchdog retired a stalled load, or a load ended after
   * demand had returned to its tile. Rendering is on demand, so without this
   * kick a backoff would expire in silence.
   */
  onFrameNeeded: (() => void) | undefined;
  events: TileLoaderEvents = {};
  /**
   * The debug panel's ear on the loader, undefined (the default) without
   * the panel: every call site checks it first, so a map without the panel
   * pays one comparison a step.
   */
  statusObserver: TileLoaderStatusObserver | undefined;

  private readonly ongoing = new Map<string, OngoingTask>();
  private wantedPriorities = new Map<string, number>();
  private wanted = new Set<string>();
  private nextGeneration = 1;
  private diskInFlight = 0;
  private networkInFlight = 0;
  private cpuInFlight = 0;
  private queuedNetwork: { tile: Tile; generation: number }[] = [];
  private queuedCPU: QueuedCPUWork<Handle>[] = [];
  private readonly pending: DeduplicatedTilesFIFO;
  private readonly retry: TileRetryController;
  private readonly deadlines: Readonly<StageDeadlines>;
  private readonly now: () => number;
  private readonly scheduleWake: (delay: number, wake: () => void) => () => void;
  private cancelWake: (() => void) | undefined;
  private wakeDeadline: number | undefined;
  private readonly maxFetches: number;
  private readonly maxPrepares: number;
  private readonly maxDiskLoads: number;
  private readonly usesDiskStage: boolean;

  constructor(
    private readonly pipeline: TileLoadPipeline<Handle>,
    options: TileLoaderOptions,
  ) {
    this.maxFetches = Math.max(1, options.maxConcurrentFetches);
    this.maxPrepares = Math.max(1, options.maxConcurrentPrepares);
    this.maxDiskLoads = Math.max(1, options.maxConcurrentDiskLoads);
    this.pending = new DeduplicatedTilesFIFO(options.pendingRequestQueueCapacity);
    this.now = options.now ?? (() => performance.now() / 1000);
    this.retry = new TileRetryController(options.retryPolicy ?? defaultRetryPolicy, this.now);
    this.deadlines = options.stageDeadlines ?? defaultStageDeadlines;
    this.scheduleWake =
      options.scheduleWake ??
      ((delay, wake) => {
        const id = setTimeout(wake, delay * 1000);
        return () => clearTimeout(id);
      });
    this.usesDiskStage = pipeline.hasPreparedDiskCache;
  }

  /** Lanes in flight, for diagnostics and tests. */
  get inFlight(): { disk: number; network: number; cpu: number; ongoing: number; queuedNetwork: number; queuedCPU: number; pending: number } {
    return {
      disk: this.diskInFlight,
      network: this.networkInFlight,
      cpu: this.cpuInFlight,
      ongoing: this.ongoing.size,
      queuedNetwork: this.queuedNetwork.length,
      queuedCPU: this.queuedCPU.length,
      pending: this.pending.count,
    };
  }

  isLoading(tile: Tile): boolean {
    return this.ongoing.has(tileKey(tile));
  }

  isPreparedOnDisk(tile: Tile): boolean {
    return this.usesDiskStage && this.pipeline.isPreparedOnDisk(tile);
  }

  /**
   * Updates the tile set for the frame, in priority order: clears the pending
   * queue and reschedules. Started downloads and parses are not cancelled on
   * a brief drop out of demand (the result still lands and keeps borderline
   * tiles from looping), but what waits for a slot is dropped.
   */
  request(tiles: readonly Tile[]): void {
    const deduplicated: Tile[] = [];
    const seen = new Set<string>();
    for (const tile of tiles) {
      const key = tileKey(tile);
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(tile);
      }
    }
    this.statusObserver?.recordDemand(tiles.length, deduplicated.length, deduplicated);
    this.wanted = seen;
    this.wantedPriorities = new Map(deduplicated.map((tile, index) => [tileKey(tile), index]));
    this.pending.clear();
    this.retry.retainOnly(this.wanted);
    this.dropUnwantedQueuedNetworkWork();
    this.dropUnwantedQueuedCPUWork();
    this.reapStalledLoads(this.now());
    for (const tile of deduplicated) this.requestSingleTile(tile);
  }

  /** Stops everything: wanted, pending and retry state cleared, every stage cancelled. */
  cancelAll(): void {
    this.wanted.clear();
    this.wantedPriorities.clear();
    this.pending.clear();
    for (const work of this.queuedCPU) this.pipeline.releaseDownload(work.download.handle);
    this.queuedNetwork = [];
    this.queuedCPU = [];
    this.retry.reset();
    this.cancelWake?.();
    this.cancelWake = undefined;
    this.wakeDeadline = undefined;
    for (const task of this.ongoing.values()) task.controller.abort();
    if (this.statusObserver) this.statusObserver.recordLoadsCancelled([...this.ongoing.values()].map((task) => task.tile));
    this.ongoing.clear();
    this.diskInFlight = 0;
    this.networkInFlight = 0;
    this.cpuInFlight = 0;
  }

  // MARK: Scheduling

  private requestSingleTile(tile: Tile): void {
    const key = tileKey(tile);
    if (!this.wanted.has(key)) return;
    const ongoing = this.ongoing.get(key);
    if (ongoing) {
      if (ongoing.landed) ongoing.demandReturned = true;
      this.statusObserver?.recordSchedulerAlreadyLoading?.(tile);
      return;
    }
    if (this.retry.shouldBlock(tile)) {
      this.statusObserver?.recordSchedulerRetryBlocked?.(tile);
      return;
    }
    const inFlight = this.usesDiskStage ? this.diskInFlight : this.networkInFlight;
    const limit = this.usesDiskStage ? this.maxDiskLoads : this.maxFetches;
    if (inFlight >= limit) {
      this.pending.enqueue(tile);
      this.statusObserver?.recordSchedulerEnqueued?.(tile, inFlight);
      return;
    }
    this.createLoadTask(tile);
  }

  /**
   * Tiles parked for the network are dropped when demand leaves them: a fast
   * pan over a cold area must not download every tile wanted for one frame.
   */
  private dropUnwantedQueuedNetworkWork(): void {
    this.queuedNetwork = this.queuedNetwork.filter((work) => {
      const key = tileKey(work.tile);
      const task = this.ongoing.get(key);
      if (task?.generation !== work.generation || task.stage !== "networkQueued") return false;
      if (this.wanted.has(key)) return true;
      this.ongoing.delete(key);
      this.statusObserver?.recordLoadDropped(work.tile);
      return false;
    });
  }

  /** Downloaded tiles waiting for a parse slot are dropped when demand leaves them, likewise. */
  private dropUnwantedQueuedCPUWork(): void {
    this.queuedCPU = this.queuedCPU.filter((work) => {
      const key = tileKey(work.tile);
      const task = this.ongoing.get(key);
      if (task?.generation !== work.generation || task.stage !== "cpuQueued") {
        this.pipeline.releaseDownload(work.download.handle);
        return false;
      }
      if (this.wanted.has(key)) return true;
      this.ongoing.delete(key);
      this.statusObserver?.recordLoadDropped(work.tile);
      this.pipeline.releaseDownload(work.download.handle);
      return false;
    });
  }

  private createLoadTask(tile: Tile): void {
    const generation = this.nextGeneration++;
    const task: OngoingTask = {
      tile,
      generation,
      controller: new AbortController(),
      stage: this.usesDiskStage ? "disk" : "network",
      stageStartedAt: this.now(),
      landed: false,
      demandReturned: false,
    };
    this.ongoing.set(tileKey(tile), task);
    if (this.usesDiskStage) {
      this.diskInFlight++;
      this.statusObserver?.recordLoadScheduled(tile, this.diskInFlight);
      void this.runDiskStage(task);
    } else {
      this.networkInFlight++;
      this.statusObserver?.recordLoadScheduled(tile, this.networkInFlight);
      void this.runNetworkStage(task);
    }
    this.armWake();
  }

  private isCurrent(task: OngoingTask, stage?: LoadStage): boolean {
    const current = this.ongoing.get(tileKey(task.tile));
    return current?.generation === task.generation && (stage === undefined || current.stage === stage);
  }

  private enterStage(task: OngoingTask, stage: LoadStage): void {
    task.stage = stage;
    task.stageStartedAt = this.now();
  }

  // MARK: Disk stage

  /** A hit is final. A miss, or an entry that cannot be materialized, continues to the network. */
  private async runDiskStage(task: OngoingTask): Promise<void> {
    let served = false;
    const observer = this.statusObserver;
    if (observer) {
      observer.recordLoadStarted(task.tile, true);
      observer.recordDiskStarted(task.tile);
    }
    try {
      const outcome = await this.pipeline.readDisk(task.tile, task.controller.signal);
      if (outcome === undefined) {
        if (this.isCurrent(task, "disk")) this.statusObserver?.recordDiskMissed(task.tile, "no_entry");
      } else if (this.isCurrent(task, "disk")) {
        if (outcome === "materialized") {
          this.statusObserver?.recordDiskServed(task.tile);
          served = this.markLoadSucceeded(task, "prepared_disk");
        } else {
          this.statusObserver?.recordDiskMissed(task.tile, outcome === "imageUnreadable" ? "image_unreadable" : "materialize_failed");
          if (outcome === "imageUnreadable") this.pipeline.removeDiskEntry(task.tile);
        }
      }
    } catch {
      // A failed read is a miss: the network stage follows.
      if (this.isCurrent(task, "disk") && !task.controller.signal.aborted) this.statusObserver?.recordDiskMissed(task.tile, "read_failed");
    }
    if (!this.isCurrent(task, "disk")) return;
    this.diskInFlight = Math.max(0, this.diskInFlight - 1);
    this.startNextPendingLoad();
    if (served || task.controller.signal.aborted) {
      this.finishLoading(task);
      return;
    }
    this.enterStage(task, "networkQueued");
    if (this.networkInFlight < this.maxFetches) this.startNetworkStage(task);
    else this.queuedNetwork.push({ tile: task.tile, generation: task.generation });
  }

  // MARK: Network stage

  private startNetworkStage(task: OngoingTask): void {
    this.networkInFlight++;
    this.enterStage(task, "network");
    void this.runNetworkStage(task);
    this.armWake();
  }

  /** Starts parked network work while slots remain, by current demand priority. */
  private startNextQueuedNetworkWork(): void {
    while (this.networkInFlight < this.maxFetches && this.queuedNetwork.length > 0) {
      this.queuedNetwork = this.queuedNetwork.filter((work) => {
        const task = this.ongoing.get(tileKey(work.tile));
        return task?.generation === work.generation && task.stage === "networkQueued";
      });
      const best = this.bestIndex(this.queuedNetwork);
      if (best < 0) return;
      const [work] = this.queuedNetwork.splice(best, 1);
      const task = this.ongoing.get(tileKey(work!.tile));
      if (task) this.startNetworkStage(task);
    }
  }

  /** Downloads the tile and frees the network slot right after, without waiting for the parse. */
  private async runNetworkStage(task: OngoingTask): Promise<void> {
    const observer = this.statusObserver;
    if (observer) {
      observer.recordLoadStarted(task.tile, !this.usesDiskStage);
      observer.recordNetworkStarted(task.tile);
    }
    let outcome: DownloadOutcome<Handle> | undefined;
    try {
      outcome = await this.pipeline.download(task.tile, task.controller.signal);
    } catch {
      outcome = task.controller.signal.aborted ? undefined : { ok: false, failure: { kind: "network" } };
    }
    if (!this.isCurrent(task, "network")) {
      if (outcome?.ok) this.pipeline.releaseDownload(outcome.handle);
      return;
    }
    if (this.statusObserver && outcome && !task.controller.signal.aborted) {
      if (outcome.ok) this.statusObserver.recordNetworkSucceeded(task.tile, outcome.bytes ?? 0);
      else this.statusObserver.recordNetworkFailed(task.tile, downloadFailureDescription(outcome.failure));
    }
    this.networkInFlight = Math.max(0, this.networkInFlight - 1);
    this.enterStage(task, "cpuQueued");
    if (this.usesDiskStage) this.startNextQueuedNetworkWork();
    else this.startNextPendingLoad();
    if (!outcome || task.controller.signal.aborted) {
      if (outcome?.ok) this.pipeline.releaseDownload(outcome.handle);
      this.finishLoading(task);
      return;
    }
    if (!outcome.ok) {
      this.markLoadFailed(task, { kind: "download", failure: outcome.failure });
      this.finishLoading(task);
      return;
    }
    const download = { handle: outcome.handle, etag: outcome.etag };
    if (this.cpuInFlight < this.maxPrepares) this.startCPUStage(task, download);
    else this.queuedCPU.push({ tile: task.tile, generation: task.generation, download });
  }

  // MARK: CPU stage

  private startCPUStage(task: OngoingTask, download: { handle: Handle; etag: string | undefined }): void {
    this.cpuInFlight++;
    this.enterStage(task, "cpu");
    void this.runCPUStage(task, download);
    this.armWake();
  }

  /**
   * Starts deferred CPU stages by current demand priority, not FIFO: coarse
   * distant tiles download faster than detailed near ones and would overtake
   * them in network completion order.
   */
  private startNextQueuedCPUWork(): void {
    while (this.cpuInFlight < this.maxPrepares && this.queuedCPU.length > 0) {
      this.queuedCPU = this.queuedCPU.filter((work) => {
        const task = this.ongoing.get(tileKey(work.tile));
        const live = task?.generation === work.generation && task.stage === "cpuQueued";
        if (!live) this.pipeline.releaseDownload(work.download.handle);
        return live;
      });
      const best = this.bestIndex(this.queuedCPU);
      if (best < 0) return;
      const [work] = this.queuedCPU.splice(best, 1);
      const task = this.ongoing.get(tileKey(work!.tile));
      if (task) this.startCPUStage(task, work!.download);
    }
  }

  private async runCPUStage(task: OngoingTask, download: { handle: Handle; etag: string | undefined }): Promise<void> {
    let parsed = false;
    let onParsed: ((layerTimings: readonly TileParseLayerTiming[]) => void) | undefined;
    if (this.statusObserver) {
      this.statusObserver.recordParsingStarted(task.tile);
      onParsed = (layerTimings) => {
        if (parsed || !this.isCurrent(task) || task.controller.signal.aborted) return;
        parsed = true;
        this.statusObserver?.recordParsingSucceeded(task.tile, layerTimings);
        this.statusObserver?.recordMaterializationStarted(task.tile);
      };
    }
    try {
      const outcome = await this.pipeline.prepare(task.tile, download, task.controller.signal, onParsed);
      if (this.isCurrent(task) && !task.controller.signal.aborted) {
        const observer = this.statusObserver;
        if (observer) {
          if (!outcome.ok) {
            observer.recordParsingFailed(task.tile, "parse_failed");
          } else {
            onParsed?.([]);
            if (outcome.materialize === "materialized") observer.recordMaterializationSucceeded(task.tile);
            else observer.recordMaterializationFailed(task.tile, "materialize_failed");
          }
        }
        if (!outcome.ok) {
          this.markLoadFailed(task, { kind: "parseFailed" });
        } else if (outcome.materialize === "materialized") {
          this.markLoadSucceeded(task, "network");
        } else {
          this.markLoadFailed(task, { kind: "materializeFailed" });
        }
      }
    } catch {
      if (this.isCurrent(task) && !task.controller.signal.aborted) {
        this.statusObserver?.recordParsingFailed(task.tile, "parse_failed");
        this.markLoadFailed(task, { kind: "parseFailed" });
      }
    }
    if (this.isCurrent(task, "cpu")) this.cpuInFlight = Math.max(0, this.cpuInFlight - 1);
    this.startNextQueuedCPUWork();
    this.finishLoading(task);
  }

  /** Tiles outside the current demand are parsed last until the next request drops them. */
  private bestIndex(work: readonly { tile: Tile }[]): number {
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < work.length; i++) {
      const rank = this.wantedPriorities.get(tileKey(work[i]!.tile)) ?? Number.MAX_SAFE_INTEGER;
      if (rank < bestRank) {
        bestRank = rank;
        best = i;
      }
    }
    return best;
  }

  // MARK: Outcomes

  private markLoadSucceeded(task: OngoingTask, source: string): boolean {
    if (!this.isCurrent(task)) return false;
    // What follows (the disk save) gets its own deadline window, retired without a failure.
    task.landed = true;
    task.stageStartedAt = this.now();
    this.retry.registerSuccess(task.tile);
    this.statusObserver?.recordLoadCompleted(task.tile, source);
    return true;
  }

  private markLoadFailed(task: OngoingTask, reason: TileRetryFailureReason): void {
    if (!this.isCurrent(task)) return;
    this.retry.registerFailure(task.tile, reason);
    const wakeAt = this.retry.earliestNextRetryDate();
    if (wakeAt !== undefined) this.scheduleWakeAt(wakeAt);
    this.statusObserver?.recordLoadFailed(task.tile, retryFailureDescription(reason));
    this.events.onLoadFailed?.(task.tile, reason);
  }

  private finishLoading(task: OngoingTask): void {
    if (!this.isCurrent(task)) return;
    const key = tileKey(task.tile);
    this.ongoing.delete(key);
    this.statusObserver?.recordLoadEnded(task.tile);
    this.events.onLoadEnded?.(task.tile);
    if (task.demandReturned && this.wanted.has(key)) this.onFrameNeeded?.();
  }

  /** Starts the next suitable tile from the pending queue in the freed entry-lane slot. */
  private startNextPendingLoad(): void {
    for (let tile = this.pending.dequeue(); tile; tile = this.pending.dequeue()) {
      const key = tileKey(tile);
      if (this.wanted.has(key) && !this.ongoing.has(key)) {
        this.requestSingleTile(tile);
        break;
      }
    }
  }

  // MARK: Watchdog

  private deadline(stage: LoadStage): number | undefined {
    switch (stage) {
      case "disk":
        return this.deadlines.disk;
      case "network":
        return this.deadlines.network;
      case "cpu":
        return this.deadlines.cpu;
      default:
        return undefined;
    }
  }

  /** Retires every load whose slot-holding stage outlived its deadline. */
  private reapStalledLoads(now: number): boolean {
    let freedEntrySlots = 0;
    let reaped = false;
    for (const [key, task] of this.ongoing) {
      const deadline = this.deadline(task.stage);
      if (deadline === undefined || now - task.stageStartedAt < deadline) continue;
      task.controller.abort();
      this.ongoing.delete(key);
      if (task.stage === "disk") {
        this.diskInFlight = Math.max(0, this.diskInFlight - 1);
        freedEntrySlots++;
      } else if (task.stage === "network") {
        this.networkInFlight = Math.max(0, this.networkInFlight - 1);
        if (!this.usesDiskStage) freedEntrySlots++;
      } else if (task.stage === "cpu") {
        this.cpuInFlight = Math.max(0, this.cpuInFlight - 1);
      }
      const stageName = task.landed ? "save" : task.stage === "cpu" ? "parse" : task.stage;
      this.statusObserver?.recordLoadStalled(task.tile, stageName, now - task.stageStartedAt, task.landed);
      if (!task.landed) {
        const reason: TileRetryFailureReason = { kind: "stalled", stage: stageName };
        this.retry.registerFailure(task.tile, reason);
        this.events.onLoadFailed?.(task.tile, reason);
      }
      reaped = true;
    }
    if (!reaped) return false;
    for (let i = 0; i < freedEntrySlots; i++) this.startNextPendingLoad();
    this.startNextQueuedNetworkWork();
    this.startNextQueuedCPUWork();
    this.armWake();
    return true;
  }

  private earliestStageDeadline(): number | undefined {
    let earliest: number | undefined;
    for (const task of this.ongoing.values()) {
      const deadline = this.deadline(task.stage);
      if (deadline === undefined) continue;
      const at = task.stageStartedAt + deadline;
      if (earliest === undefined || at < earliest) earliest = at;
    }
    return earliest;
  }

  /** Arms the wake for whichever comes first: a retry window expiring or a stage outliving its deadline. */
  private armWake(): void {
    const candidates = [this.retry.earliestNextRetryDate(), this.earliestStageDeadline()].filter((v): v is number => v !== undefined);
    if (candidates.length === 0) return;
    this.scheduleWakeAt(Math.min(...candidates));
  }

  /** An earlier armed wake absorbs later ones: after firing it re-arms for the next. */
  private scheduleWakeAt(at: number): void {
    if (this.wakeDeadline !== undefined && this.wakeDeadline <= at) return;
    this.cancelWake?.();
    this.wakeDeadline = at;
    this.cancelWake = this.scheduleWake(Math.max(0, at - this.now()), () => this.wakeDidFire());
  }

  private wakeDidFire(): void {
    this.cancelWake = undefined;
    this.wakeDeadline = undefined;
    this.reapStalledLoads(this.now());
    const shouldNotify = this.wanted.size > 0;
    this.armWake();
    if (shouldNotify) this.onFrameNeeded?.();
  }
}
