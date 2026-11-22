// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileLoadingStatusReporterTests`, the reporter's
// parts of `ImmersiveMapNeedsTileTests`, and the CPU parts of
// `DebugOverlayHUDLiveTileRowsTests`: the rows, their stages and ages, and a
// row that lands after the last frame reaching the panel on the reporter's
// word. The loader runs over a controlled pipeline whose promises the tests
// settle, with microtasks flushed between the steps. No sleeps.

import { describe, expect, test } from "vitest";
import type { DownloadOutcome, MaterializeOutcome, PrepareOutcome, TileLoadPipeline, TileParseLayerTiming } from "../../tile/loading/tile-loader.ts";
import { TileLoader } from "../../tile/loading/tile-loader.ts";
import { type Tile, tileKey } from "../../tile/tile.ts";
import { DebugOverlayHUDSnapshotStore } from "./debug-overlay-hud-snapshot-store.ts";
import { TileLoadingStatusReporter, TileLoadingStatusSnapshot, type TileLoadingStatusTileSnapshot } from "./tile-loading-status-reporter.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface PendingPrepare {
  deferred: Deferred<PrepareOutcome>;
  onParsed: ((timings: readonly TileParseLayerTiming[]) => void) | undefined;
}

class ControlledPipeline implements TileLoadPipeline<string> {
  readonly hasPreparedDiskCache: boolean;
  readonly diskReads = new Map<string, Deferred<MaterializeOutcome | undefined>>();
  readonly downloads = new Map<string, Deferred<DownloadOutcome<string>>>();
  readonly prepares = new Map<string, PendingPrepare>();

  constructor(disk = false) {
    this.hasPreparedDiskCache = disk;
  }

  isPreparedOnDisk(): boolean {
    return false;
  }

  readDisk(tile: Tile): Promise<MaterializeOutcome | undefined> {
    const d = deferred<MaterializeOutcome | undefined>();
    this.diskReads.set(tileKey(tile), d);
    return d.promise;
  }

  removeDiskEntry(): void {}

  download(tile: Tile): Promise<DownloadOutcome<string>> {
    const d = deferred<DownloadOutcome<string>>();
    this.downloads.set(tileKey(tile), d);
    return d.promise;
  }

  prepare(tile: Tile, _download: unknown, _signal: AbortSignal, onParsed?: (timings: readonly TileParseLayerTiming[]) => void): Promise<PrepareOutcome> {
    const d = deferred<PrepareOutcome>();
    this.prepares.set(tileKey(tile), { deferred: d, onParsed });
    return d.promise;
  }

  releaseDownload(): void {}

  completeDownload(tile: Tile, bytes: number): void {
    this.downloads.get(tileKey(tile))!.resolve({ ok: true, handle: tileKey(tile), etag: "A", bytes });
  }

  /** The parse ends: the worker's answer is in, the materialize starts. */
  completeParse(tile: Tile, timings: readonly TileParseLayerTiming[] = []): void {
    this.prepares.get(tileKey(tile))!.onParsed?.(timings);
  }

  completeMaterialize(tile: Tile, outcome: MaterializeOutcome = "materialized"): void {
    this.prepares.get(tileKey(tile))!.deferred.resolve({ ok: true, materialize: outcome });
  }
}

function makeLoader(pipeline: ControlledPipeline, reporter: TileLoadingStatusReporter): TileLoader<string> {
  const loader = new TileLoader(pipeline, {
    maxConcurrentFetches: 1,
    pendingRequestQueueCapacity: 16,
    maxConcurrentPrepares: 1,
    maxConcurrentDiskLoads: 1,
    now: () => 0,
    scheduleWake: () => () => {},
  });
  loader.statusObserver = reporter;
  return loader;
}

function row(snapshot: TileLoadingStatusSnapshot, tile: Tile): TileLoadingStatusTileSnapshot | undefined {
  return snapshot.tiles.find((entry) => tileKey(entry.tile) === tileKey(tile));
}

describe("TileLoadingStatusReporter", () => {
  test("a live row grows old until its detail changes", () => {
    let now = 100;
    const reporter = new TileLoadingStatusReporter(() => now);
    const tile: Tile = { x: 77, y: 40, z: 7 };
    reporter.recordDemand(1, 1, [tile]);
    reporter.recordLoadScheduled(tile);
    reporter.recordLoadStarted(tile);
    reporter.recordParsingStarted(tile);
    now = 103.4;
    expect(reporter.snapshot().tiles[0]?.stageAgeSeconds).toBe(3);

    reporter.recordParsingSucceeded(tile);
    expect(reporter.snapshot().tiles[0]?.detail, "a new detail starts a new age").toBe("materialize");
    expect(reporter.snapshot().tiles[0]?.stageAgeSeconds).toBe(0);
    now = 105;
    expect(reporter.snapshot().tiles[0]?.stageAgeSeconds).toBe(1);

    reporter.recordLoadCompleted(tile);
    now = 200;
    expect(reporter.snapshot().tiles[0]?.status).toBe("ready");
    expect(reporter.snapshot().tiles[0]?.stageAgeSeconds, "a finished row is not waiting for anything").toBe(0);
  });

  test("a stalled load closes its phase and fails", () => {
    const reporter = new TileLoadingStatusReporter();
    const tile: Tile = { x: 1, y: 1, z: 4 };
    reporter.recordDemand(1, 1, [tile]);
    reporter.recordLoadScheduled(tile);
    reporter.recordLoadStarted(tile);
    reporter.recordDiskStarted(tile);
    expect(reporter.snapshot().disk.inFlight).toBe(1);
    expect(reporter.snapshot().activeLoads).toBe(1);

    reporter.recordLoadStalled(tile, "disk");

    const snapshot = reporter.snapshot();
    expect(snapshot.disk.inFlight).toBe(0);
    expect(snapshot.activeLoads).toBe(0);
    expect(snapshot.totalFailed).toBe(1);
    expect(snapshot.latestFailure).toBe("stalled in disk");
    expect(snapshot.latestDiskTile).toBeUndefined();
    expect(snapshot.tiles[0]?.status).toBe("failed");
    expect(snapshot.tiles[0]?.detail).toBe("stalled in disk");
    expect(snapshot.tiles[0]?.preparationStages.map((stage) => stage.name), "the phase it stalled in is closed").toEqual(["disk"]);
  });

  test("an ended load demotes only a live row", () => {
    const reporter = new TileLoadingStatusReporter();
    const live: Tile = { x: 1, y: 1, z: 4 };
    const done: Tile = { x: 2, y: 1, z: 4 };
    reporter.recordDemand(2, 2, [live, done]);
    for (const tile of [live, done]) {
      reporter.recordLoadScheduled(tile);
      reporter.recordLoadStarted(tile);
      reporter.recordNetworkStarted(tile);
    }
    reporter.recordNetworkSucceeded(done, 10);
    reporter.recordLoadCompleted(done);
    reporter.recordLoadEnded(live);
    reporter.recordLoadEnded(done);

    const snapshot = reporter.snapshot();
    expect(row(snapshot, live)?.status).toBe("failed");
    expect(row(snapshot, live)?.detail).toBe("ended in network");
    expect(snapshot.network.inFlight).toBe(0);
    expect(snapshot.activeLoads).toBe(0);
    expect(row(snapshot, done)?.status).toBe("ready");
    expect(row(snapshot, done)?.detail).toBe("ready");
  });

  test("a displayed tile keeps its recent stages after demand pruned its ready row", () => {
    let now = 1;
    const reporter = new TileLoadingStatusReporter(() => now);
    const tile: Tile = { x: 11, y: 6, z: 4 };
    reporter.recordDemand(1, 1, [tile]);
    reporter.recordNetworkStarted(tile);
    now = 1.1;
    reporter.recordNetworkSucceeded(tile, 1024);
    reporter.recordParsingStarted(tile);
    now = 1.35;
    reporter.recordParsingSucceeded(tile, [
      { layerName: "boundaries", duration: 0.244 },
      { layerName: "ocean", duration: 0.044 },
    ]);
    reporter.recordMaterializationStarted(tile);
    now = 1.38;
    reporter.recordMaterializationSucceeded(tile);
    reporter.recordDemand(0, 0, []);
    reporter.recordLoadCompleted(tile);
    expect(row(reporter.snapshot(), tile)).toBeUndefined();

    reporter.recordDisplayedTiles([tile]);

    const stages = reporter.snapshot().tiles[0]!.preparationStages;
    expect(stages.map((stage) => stage.name)).toEqual(["network", "parse", "materialize", "ready"]);
    expect(stages[1]!.layerTimings.map((timing) => timing.layerName)).toEqual(["boundaries", "ocean"]);
    expect(stages[0]!.duration).toBeCloseTo(0.1, 9);
    expect(stages[3]!.duration, "ready is an instant").toBeUndefined();
  });

  test("the displayed tiles outside demand are listed, every one of them", () => {
    const reporter = new TileLoadingStatusReporter();
    const displayed: Tile = { x: 4, y: 2, z: 3 };
    reporter.recordDemand(0, 0, []);
    reporter.recordDisplayedTiles([displayed]);
    expect(reporter.snapshot().tiles.map((entry) => entry.tile)).toEqual([displayed]);

    const many = Array.from({ length: 80 }, (_, x): Tile => ({ x, y: 1, z: 7 }));
    reporter.recordDisplayedTiles(many);
    expect(reporter.snapshot().tiles).toHaveLength(80);
  });

  test("a cancellation clears the demand without active loads", () => {
    const reporter = new TileLoadingStatusReporter();
    reporter.recordDemand(1, 1, [{ x: 1, y: 1, z: 4 }]);
    reporter.recordLoadsCancelled([]);
    const snapshot = reporter.snapshot();
    expect(snapshot.requested).toBe(0);
    expect(snapshot.deduplicated).toBe(0);
    expect(snapshot.tiles).toHaveLength(0);
  });

  test("the lines say nothing before the loader did anything, then one value a line", () => {
    const reporter = new TileLoadingStatusReporter();
    expect(TileLoadingStatusSnapshot.lines(reporter.snapshot())).toEqual([]);
    const tile: Tile = { x: 8, y: 6, z: 4 };
    reporter.recordDemand(1, 1, [tile]);
    reporter.recordParsingStarted(tile);
    reporter.recordParsingSucceeded(tile, [
      { layerName: "water", duration: 0.053 },
      { layerName: "landcover", duration: 0.027 },
      { layerName: "roads", duration: 0.1 },
      { layerName: "pois", duration: 0.01 },
    ]);
    reporter.recordParsingStarted({ x: 9, y: 6, z: 4 });
    const lines = TileLoadingStatusSnapshot.lines(reporter.snapshot());
    expect(lines.slice(0, 2)).toEqual(["requested:1", "deduplicated:1"]);
    expect(lines).toContain("parse done:1");
    expect(lines).toContain("current parse:z4/9/6");
    expect(lines.at(-1)).toBe("parse layers z4/8/6: roads 100ms, water 53ms, landcover 27ms");
  });

  test("the loader with a reporter attached reports every step of a network load", async () => {
    const pipeline = new ControlledPipeline();
    const reporter = new TileLoadingStatusReporter();
    const loader = makeLoader(pipeline, reporter);
    const tile: Tile = { x: 3, y: 2, z: 5 };
    loader.request([tile]);
    expect(row(reporter.snapshot(), tile)?.detail).toBe("network");
    expect(reporter.snapshot().network.inFlight).toBe(1);
    pipeline.completeDownload(tile, 512);
    await flush();
    expect(row(reporter.snapshot(), tile)?.detail).toBe("parse");
    expect(reporter.snapshot().networkBytes).toBe(512);
    pipeline.completeParse(tile);
    expect(row(reporter.snapshot(), tile)?.detail).toBe("materialize");
    pipeline.completeMaterialize(tile);
    await flush();
    const snapshot = reporter.snapshot();
    expect(row(snapshot, tile)?.status).toBe("ready");
    expect(row(snapshot, tile)?.preparationStages.map((stage) => stage.name)).toEqual(["network", "parse", "materialize", "ready"]);
    expect([snapshot.activeLoads, snapshot.totalCompleted, snapshot.parsing.completed]).toEqual([0, 1, 1]);
  });

  test("a disk hit is one served disk stage", async () => {
    const pipeline = new ControlledPipeline(true);
    const reporter = new TileLoadingStatusReporter();
    const loader = makeLoader(pipeline, reporter);
    const tile: Tile = { x: 3, y: 2, z: 5 };
    loader.request([tile]);
    expect(row(reporter.snapshot(), tile)?.detail).toBe("disk");
    pipeline.diskReads.get(tileKey(tile))!.resolve("materialized");
    await flush();
    const snapshot = reporter.snapshot();
    expect(snapshot.disk).toEqual({ inFlight: 0, completed: 1, failed: 0 });
    expect(row(snapshot, tile)?.preparationStages.map((stage) => stage.name)).toEqual(["disk", "ready"]);
    expect(snapshot.network.inFlight).toBe(0);
  });

  test("a cancellation clears the reporter and a late parse records nothing", async () => {
    const pipeline = new ControlledPipeline();
    const reporter = new TileLoadingStatusReporter();
    const loader = makeLoader(pipeline, reporter);
    const tile: Tile = { x: 1, y: 1, z: 4 };
    loader.request([tile]);
    pipeline.completeDownload(tile, 3);
    await flush();
    expect(reporter.snapshot().activeLoads).toBe(1);
    expect(reporter.snapshot().parsing.inFlight).toBe(1);

    loader.cancelAll();
    let snapshot = reporter.snapshot();
    expect([snapshot.requested, snapshot.activeLoads, snapshot.network.inFlight, snapshot.parsing.inFlight]).toEqual([0, 0, 0, 0]);
    expect(snapshot.latestNetworkTile).toBeUndefined();
    expect(snapshot.latestParsingTile).toBeUndefined();
    expect(row(snapshot, tile)).toBeUndefined();

    pipeline.completeParse(tile);
    pipeline.completeMaterialize(tile);
    await flush();
    snapshot = reporter.snapshot();
    expect([snapshot.activeLoads, snapshot.parsing.inFlight, snapshot.totalCompleted, snapshot.totalFailed]).toEqual([0, 0, 0, 0]);
  });
});

describe("the debug HUD's live tile rows", () => {
  /** The panel's flush: the newest frame snapshot when there is one, otherwise the between-frames refresh. */
  class ReplayedPanel {
    private consumedVersion = 0;
    applied: TileLoadingStatusSnapshot | undefined;
    appliedCount = 0;

    constructor(private readonly store: DebugOverlayHUDSnapshotStore<TileLoadingStatusSnapshot, TileLoadingStatusSnapshot>) {}

    tick(): void {
      const value = this.store.consumeLatest(this.consumedVersion);
      if (value) {
        this.consumedVersion = value.version;
        this.applied = value.snapshot;
        this.appliedCount += 1;
        return;
      }
      const refreshed = this.store.refreshedSnapshot(this.applied, (_, status) => status, TileLoadingStatusSnapshot.equals);
      if (refreshed) {
        this.applied = refreshed;
        this.appliedCount += 1;
      }
    }

    shownRow(tile: Tile): TileLoadingStatusTileSnapshot | undefined {
      return this.applied === undefined ? undefined : row(this.applied, tile);
    }
  }

  const tile: Tile = { x: 77, y: 40, z: 7 };

  test("a row landing after the last frame is refreshed on the reporter's word while the loop sleeps", async () => {
    const pipeline = new ControlledPipeline();
    const reporter = new TileLoadingStatusReporter();
    const loader = makeLoader(pipeline, reporter);
    const store = new DebugOverlayHUDSnapshotStore<TileLoadingStatusSnapshot, TileLoadingStatusSnapshot>();
    store.attachTileLoadingStatus(() => reporter.snapshot());
    let words = 0;
    store.onTileLoadingStatusChanged = () => (words += 1);
    reporter.onChange = () => store.noteTileLoadingStatusChanged();
    const panel = new ReplayedPanel(store);
    const render = () => store.publish(reporter.snapshot());

    loader.request([tile]);
    pipeline.completeDownload(tile, 1);
    await flush();
    render();
    panel.tick();
    expect(panel.shownRow(tile)?.detail).toBe("parse");

    pipeline.completeParse(tile);
    render();
    panel.tick();
    expect(panel.shownRow(tile)?.detail).toBe("materialize");
    const wordsBeforeLanding = words;

    // The tile lands with no frame after it: only the reporter's word moves the panel.
    pipeline.completeMaterialize(tile);
    await flush();
    expect(row(reporter.snapshot(), tile)?.detail).toBe("ready");
    expect(words, "the reporter announced the landing").toBeGreaterThan(wordsBeforeLanding);

    const appliedBefore = panel.appliedCount;
    panel.tick();
    expect(panel.shownRow(tile)?.detail).toBe("ready");
    expect(panel.appliedCount, "one between-frames refresh").toBe(appliedBefore + 1);
    panel.tick();
    expect(panel.appliedCount, "a quiet loader costs the panel nothing more").toBe(appliedBefore + 1);
    loader.cancelAll();
  });

  test("a row that really stays in a stage shows its age growing", async () => {
    let now = 1000;
    const pipeline = new ControlledPipeline();
    const reporter = new TileLoadingStatusReporter(() => now);
    const loader = makeLoader(pipeline, reporter);
    const store = new DebugOverlayHUDSnapshotStore<TileLoadingStatusSnapshot, TileLoadingStatusSnapshot>();
    store.attachTileLoadingStatus(() => reporter.snapshot());
    const panel = new ReplayedPanel(store);

    loader.request([tile]);
    pipeline.completeDownload(tile, 1);
    await flush();
    store.publish(reporter.snapshot());
    panel.tick();
    expect(panel.shownRow(tile)?.detail).toBe("parse");
    expect(panel.shownRow(tile)?.stageAgeSeconds).toBe(0);

    now = 1012;
    panel.tick();
    expect(panel.shownRow(tile)?.detail).toBe("parse");
    expect(panel.shownRow(tile)?.stageAgeSeconds, "no frame follows, the parse does not end: the row ages on screen").toBe(12);
    loader.cancelAll();
  });
});
