// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `ImmersiveMapNeedsTileTests`: the parts about the
// orchestrator (lanes, priorities, retries, the watchdog). The status
// reporter's tests move with the reporter. No sleeps: every step is driven
// by settling the controlled pipeline's promises and flushing microtasks.

import { describe, expect, test } from "vitest";
import type { DownloadFailure } from "./download-failure.ts";
import { defaultRetryPolicy } from "./retry-controller.ts";
import { type DownloadOutcome, type MaterializeOutcome, type PrepareOutcome, TileLoader, type TileLoadPipeline } from "./tile-loader.ts";
import { type Tile, tileKey } from "../tile.ts";

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

class ControlledPipeline implements TileLoadPipeline<string> {
  readonly hasPreparedDiskCache: boolean;
  readonly diskReads = new Map<string, Deferred<MaterializeOutcome | undefined>[]>();
  readonly downloads = new Map<string, Deferred<DownloadOutcome<string>>[]>();
  readonly prepares = new Map<string, Deferred<PrepareOutcome>[]>();
  readonly aborted = new Set<string>();
  readonly removed: string[] = [];
  readonly released: string[] = [];
  onDisk = new Set<string>();

  constructor(options: { disk?: boolean } = {}) {
    this.hasPreparedDiskCache = options.disk ?? false;
  }

  isPreparedOnDisk(tile: Tile): boolean {
    return this.onDisk.has(tileKey(tile));
  }

  private push<T>(map: Map<string, Deferred<T>[]>, tile: Tile, signal: AbortSignal): Promise<T> {
    const key = tileKey(tile);
    const d = deferred<T>();
    map.set(key, [...(map.get(key) ?? []), d]);
    signal.addEventListener("abort", () => this.aborted.add(key));
    return d.promise;
  }

  readDisk(tile: Tile, signal: AbortSignal) {
    return this.push(this.diskReads, tile, signal);
  }

  removeDiskEntry(tile: Tile): void {
    this.removed.push(tileKey(tile));
  }

  download(tile: Tile, signal: AbortSignal) {
    return this.push(this.downloads, tile, signal);
  }

  prepare(tile: Tile, _download: { handle: string; etag: string | undefined }, signal: AbortSignal) {
    return this.push(this.prepares, tile, signal);
  }

  releaseDownload(handle: string): void {
    this.released.push(handle);
  }

  started(tile: Tile): number {
    return this.downloads.get(tileKey(tile))?.length ?? 0;
  }

  diskReadCount(tile: Tile): number {
    return this.diskReads.get(tileKey(tile))?.length ?? 0;
  }

  prepared(tile: Tile): number {
    return this.prepares.get(tileKey(tile))?.length ?? 0;
  }

  completeDisk(tile: Tile, outcome: MaterializeOutcome | undefined = undefined): void {
    this.diskReads.get(tileKey(tile))!.at(-1)!.resolve(outcome);
  }

  completeDownload(tile: Tile, outcome: { ok: true } | { ok: false; failure: DownloadFailure }): void {
    const d = this.downloads.get(tileKey(tile))!.at(-1)!;
    d.resolve(outcome.ok ? { ok: true, handle: `bytes ${tileKey(tile)}`, etag: undefined } : outcome);
  }

  completePrepare(tile: Tile, outcome: PrepareOutcome = { ok: true, materialize: "materialized" }): void {
    this.prepares.get(tileKey(tile))!.at(-1)!.resolve(outcome);
  }
}

class Clock {
  t = 1000;
  wakes: { at: number; fire: () => void; live: boolean }[] = [];
  now = () => this.t;
  schedule = (delay: number, fire: () => void) => {
    const wake = {
      at: this.t + delay,
      live: true,
      fire: () => {
        wake.live = false;
        fire();
      },
    };
    this.wakes.push(wake);
    return () => {
      wake.live = false;
    };
  };
  get live() {
    return this.wakes.filter((w) => w.live);
  }
}

const tile = (x: number, y = 1, z = 4): Tile => ({ x, y, z });
const network: DownloadFailure = { kind: "network" };

function makeLoader(pipeline: ControlledPipeline, options: { fetches?: number; prepares?: number; disks?: number } = {}, clock = new Clock()) {
  return new TileLoader(pipeline, {
    maxConcurrentFetches: options.fetches ?? 1,
    pendingRequestQueueCapacity: 128,
    maxConcurrentPrepares: options.prepares ?? 4,
    maxConcurrentDiskLoads: options.disks ?? 2,
    now: clock.now,
    scheduleWake: clock.schedule,
  });
}

describe("TileLoader", () => {
  test("keeps an in-flight tile when it temporarily leaves demand", async () => {
    const pipeline = new ControlledPipeline();
    const loader = makeLoader(pipeline);
    const [first, second] = [tile(1), tile(2)];
    loader.request([first]);
    expect(pipeline.started(first)).toBe(1);
    loader.request([second]);
    await flush();
    expect(pipeline.aborted.has(tileKey(first))).toBe(false);
    expect(pipeline.started(second)).toBe(0);
    pipeline.completeDownload(first, { ok: false, failure: network });
    await flush();
    expect(pipeline.started(second)).toBe(1);
  });

  test("the network slot frees while the parse is still running", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline);
    const [first, second] = [tile(1), tile(2)];
    loader.request([first, second]);
    pipeline.completeDisk(first);
    await flush();
    expect(pipeline.started(first)).toBe(1);
    pipeline.completeDisk(second);
    await flush();
    expect(pipeline.started(second)).toBe(0);
    pipeline.completeDownload(first, { ok: true });
    await flush();
    expect(pipeline.prepared(first)).toBe(1);
    expect(pipeline.started(second)).toBe(1);
  });

  test("the CPU stage honours its own concurrency limit", async () => {
    const pipeline = new ControlledPipeline();
    const loader = makeLoader(pipeline, { fetches: 2, prepares: 1 });
    const [first, second] = [tile(1), tile(2)];
    loader.request([first, second]);
    expect(pipeline.started(first)).toBe(1);
    expect(pipeline.started(second)).toBe(1);
    pipeline.completeDownload(first, { ok: true });
    await flush();
    expect(pipeline.prepared(first)).toBe(1);
    pipeline.completeDownload(second, { ok: true });
    await flush();
    expect(pipeline.prepared(second)).toBe(0);
    pipeline.completePrepare(first);
    await flush();
    expect(pipeline.prepared(second)).toBe(1);
  });

  test("a failed download arms a retry wake that fires the callback", async () => {
    const pipeline = new ControlledPipeline();
    const clock = new Clock();
    const loader = makeLoader(pipeline, {}, clock);
    let frames = 0;
    loader.onFrameNeeded = () => frames++;
    loader.request([tile(1)]);
    pipeline.completeDownload(tile(1), { ok: false, failure: network });
    await flush();
    const live = clock.live;
    expect(live.length).toBe(1);
    expect(live[0]!.at - clock.t).toBeGreaterThan(0);
    expect(live[0]!.at - clock.t).toBeLessThanOrEqual(defaultRetryPolicy.baseBackoff);
    live[0]!.fire();
    expect(frames).toBe(1);
  });

  test("cancelAll cancels the armed retry wake", async () => {
    const pipeline = new ControlledPipeline();
    const clock = new Clock();
    const loader = makeLoader(pipeline, {}, clock);
    loader.request([tile(1)]);
    pipeline.completeDownload(tile(1), { ok: false, failure: network });
    await flush();
    expect(clock.live.length).toBeGreaterThan(0);
    loader.cancelAll();
    expect(clock.live.length).toBe(0);
  });

  test("an expired retry window does not mask future windows on re-arm", async () => {
    const pipeline = new ControlledPipeline();
    const clock = new Clock();
    const loader = makeLoader(pipeline, { fetches: 2 }, clock);
    const [first, second] = [tile(1), tile(2)];
    loader.request([first, second]);
    pipeline.completeDownload(first, { ok: false, failure: network });
    await flush();
    clock.t += 0.3;
    pipeline.completeDownload(second, { ok: false, failure: network });
    await flush();
    // The first window (T+0.5) fires, the second (T+0.8) must be re-armed after it.
    clock.t = 1000.5;
    clock.live[0]!.fire();
    const next = clock.live;
    expect(next.length).toBe(1);
    expect(next[0]!.at).toBeCloseTo(1000.8, 6);
  });

  test("a stalled disk stage is retired, and the tile retried after its backoff", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const clock = new Clock();
    const loader = makeLoader(pipeline, {}, clock);
    loader.request([tile(1)]);
    expect(pipeline.diskReadCount(tile(1))).toBe(1);
    clock.t += 21;
    loader.request([tile(1)]);
    expect(pipeline.aborted.has(tileKey(tile(1)))).toBe(true);
    expect(loader.inFlight.disk).toBe(0);
    // Inside the backoff: not read again.
    expect(pipeline.diskReadCount(tile(1))).toBe(1);
    clock.t += defaultRetryPolicy.baseBackoff + 0.01;
    loader.request([tile(1)]);
    expect(pipeline.diskReadCount(tile(1))).toBe(2);
    // The stalled read's late answer is ignored.
    pipeline.diskReads.get(tileKey(tile(1)))![0]!.resolve("materialized");
    await flush();
    expect(loader.isLoading(tile(1))).toBe(true);
  });

  test("the watchdog wake retires a stalled load without a frame", async () => {
    const pipeline = new ControlledPipeline();
    const clock = new Clock();
    const loader = makeLoader(pipeline, {}, clock);
    let frames = 0;
    loader.onFrameNeeded = () => frames++;
    loader.request([tile(1)]);
    const wake = clock.live[0]!;
    expect(wake.at - clock.t).toBe(90);
    clock.t = wake.at;
    wake.fire();
    expect(loader.inFlight.network).toBe(0);
    expect(loader.isLoading(tile(1))).toBe(false);
    expect(frames).toBe(1);
  });

  test("a materialize failure backs off like a transient error", async () => {
    const pipeline = new ControlledPipeline();
    const clock = new Clock();
    const loader = makeLoader(pipeline, {}, clock);
    loader.request([tile(1)]);
    pipeline.completeDownload(tile(1), { ok: true });
    await flush();
    pipeline.completePrepare(tile(1), { ok: true, materialize: "allocationOrStoreFailed" });
    await flush();
    loader.request([tile(1)]);
    expect(pipeline.started(tile(1))).toBe(1);
    clock.t += defaultRetryPolicy.baseBackoff + 0.01;
    loader.request([tile(1)]);
    expect(pipeline.started(tile(1))).toBe(2);
  });

  test("a disk miss proceeds to the download, and a hit ends the load", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline, { fetches: 1 });
    loader.request([tile(1), tile(2)]);
    pipeline.completeDisk(tile(1));
    await flush();
    expect(pipeline.started(tile(1))).toBe(1);
    pipeline.completeDisk(tile(2), "materialized");
    await flush();
    expect(pipeline.started(tile(2))).toBe(0);
    expect(loader.isLoading(tile(2))).toBe(false);
    // The hit did not release the busy network slot.
    expect(loader.inFlight.network).toBe(1);
  });

  test("the disk lane runs while every network slot is busy, within its own limit", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline, { fetches: 1, disks: 2 });
    loader.request([tile(1)]);
    pipeline.completeDisk(tile(1));
    await flush();
    expect(pipeline.started(tile(1))).toBe(1);
    loader.request([tile(1), tile(2), tile(3), tile(4)]);
    expect(pipeline.diskReadCount(tile(2))).toBe(1);
    expect(pipeline.diskReadCount(tile(3))).toBe(1);
    expect(pipeline.diskReadCount(tile(4))).toBe(0);
    pipeline.completeDisk(tile(2), "materialized");
    await flush();
    expect(pipeline.diskReadCount(tile(4))).toBe(1);
  });

  test("cancelAll during the disk stage leaks no disk slot", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline, { disks: 1 });
    loader.request([tile(1)]);
    loader.cancelAll();
    pipeline.completeDisk(tile(1));
    await flush();
    expect(loader.inFlight.disk).toBe(0);
    loader.request([tile(2)]);
    expect(pipeline.diskReadCount(tile(2))).toBe(1);
  });

  test("isPreparedOnDisk follows the pipeline and the disk stage", () => {
    const withDisk = new ControlledPipeline({ disk: true });
    withDisk.onDisk.add(tileKey(tile(1)));
    expect(makeLoader(withDisk).isPreparedOnDisk(tile(1))).toBe(true);
    const without = new ControlledPipeline();
    without.onDisk.add(tileKey(tile(1)));
    expect(makeLoader(without).isPreparedOnDisk(tile(1))).toBe(false);
  });

  test("an unwanted tile waiting for a network slot is dropped on the next request", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline, { fetches: 1 });
    loader.request([tile(1), tile(2)]);
    pipeline.completeDisk(tile(1));
    pipeline.completeDisk(tile(2));
    await flush();
    expect(loader.inFlight.queuedNetwork).toBe(1);
    loader.request([tile(1)]);
    expect(loader.isLoading(tile(2))).toBe(false);
    pipeline.completeDownload(tile(1), { ok: false, failure: network });
    await flush();
    expect(pipeline.started(tile(2))).toBe(0);
  });

  test("an unwanted downloaded tile waiting for a parse slot is dropped, and its bytes released", async () => {
    const pipeline = new ControlledPipeline();
    const loader = makeLoader(pipeline, { fetches: 2, prepares: 1 });
    loader.request([tile(1), tile(2)]);
    pipeline.completeDownload(tile(1), { ok: true });
    pipeline.completeDownload(tile(2), { ok: true });
    await flush();
    expect(loader.inFlight.queuedCPU).toBe(1);
    loader.request([tile(1)]);
    expect(loader.isLoading(tile(2))).toBe(false);
    expect(pipeline.released).toContain(`bytes ${tileKey(tile(2))}`);
    pipeline.completePrepare(tile(1));
    await flush();
    expect(pipeline.prepared(tile(2))).toBe(0);
  });

  test("a retry-blocked tile does not read the disk", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline);
    loader.request([tile(1)]);
    pipeline.completeDisk(tile(1));
    await flush();
    pipeline.completeDownload(tile(1), { ok: false, failure: network });
    await flush();
    loader.request([tile(1)]);
    expect(pipeline.diskReadCount(tile(1))).toBe(1);
  });

  test("an unreadable disk image removes the entry and continues to the network", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline);
    loader.request([tile(1)]);
    pipeline.completeDisk(tile(1), "imageUnreadable");
    await flush();
    expect(pipeline.removed).toEqual([tileKey(tile(1))]);
    expect(pipeline.started(tile(1))).toBe(1);
  });

  test("an allocation failure on a disk hit keeps the entry and falls through to the network", async () => {
    const pipeline = new ControlledPipeline({ disk: true });
    const loader = makeLoader(pipeline);
    loader.request([tile(1)]);
    pipeline.completeDisk(tile(1), "allocationOrStoreFailed");
    await flush();
    expect(pipeline.removed).toEqual([]);
    expect(pipeline.started(tile(1))).toBe(1);
  });

  test("a demand that returns after the tile landed asks for a frame when the load ends", async () => {
    const pipeline = new ControlledPipeline();
    const loader = makeLoader(pipeline);
    let frames = 0;
    loader.onFrameNeeded = () => frames++;
    loader.request([tile(1)]);
    pipeline.completeDownload(tile(1), { ok: true });
    await flush();
    pipeline.completePrepare(tile(1));
    await flush();
    expect(frames).toBe(0);
  });
});
