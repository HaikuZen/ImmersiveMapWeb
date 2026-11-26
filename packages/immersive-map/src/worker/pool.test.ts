// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkerTilePipeline } from "./pool.ts";
import type { ToWorker, WorkerConfig } from "./protocol.ts";

/** A worker whose script `behaviour` says: loads and answers `init`, does not load, or throws as it starts. */
class FakeWorker extends EventTarget {
  static behaviour: "ready" | "notLoaded" | "throws" = "ready";
  static made: FakeWorker[] = [];
  readonly posted: ToWorker[] = [];
  constructor() {
    super();
    FakeWorker.made.push(this);
    const behaviour = FakeWorker.behaviour;
    // A script that does not load sends an `error` event with no message; one that throws, with its message.
    if (behaviour === "notLoaded") queueMicrotask(() => this.dispatchEvent(new Event("error", { cancelable: true })));
    if (behaviour === "throws") queueMicrotask(() => this.dispatchEvent(Object.assign(new Event("error", { cancelable: true }), { message: "Uncaught SyntaxError" })));
  }
  postMessage(message: ToWorker): void {
    this.posted.push(message);
    if (message.type === "init" && FakeWorker.behaviour === "ready") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { type: "ready" } })));
  }
  terminate(): void {}
}

const config: WorkerConfig = { archive: "https://example.invalid/a.pmtiles", requestHeaders: {}, overviewEnabled: false, overviewURL: "", cache: undefined, parse: {} };
const tile = { x: 0, y: 0, z: 0 };

function pipeline(behaviour: typeof FakeWorker.behaviour): WorkerTilePipeline {
  FakeWorker.behaviour = behaviour;
  FakeWorker.made = [];
  vi.stubGlobal("Worker", FakeWorker);
  return new WorkerTilePipeline(config, 2);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkerTilePipeline", () => {
  test("is ready once every worker answers its init", async () => {
    await expect(pipeline("ready").ready).resolves.toBeUndefined();
  });

  test("a worker whose script does not load rejects ready, saying why, in place of never settling", async () => {
    await expect(pipeline("notLoaded").ready).rejects.toThrow(/tile worker's script did not load.*build\.lib.*base/);
  });

  test("a worker whose script throws rejects ready with the script's error", async () => {
    await expect(pipeline("throws").ready).rejects.toThrow("ImmersiveMap: the tile worker failed: Uncaught SyntaxError");
  });

  test("a worker that fails after it is ready rejects its calls on their way and the later ones", async () => {
    const workers = pipeline("ready");
    await workers.ready;
    const signal = new AbortController().signal;
    const onTheWay = workers.download(tile, signal);
    const worker = FakeWorker.made.find((made) => made.posted.some((message) => message.type === "download"))!;
    worker.dispatchEvent(Object.assign(new Event("error", { cancelable: true }), { message: "out of memory" }));
    await expect(onTheWay).rejects.toThrow("out of memory");
    await expect(workers.download(tile, signal)).rejects.toThrow("out of memory");
  });
});
