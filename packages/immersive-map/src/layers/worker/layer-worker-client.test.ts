// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { FromLayerWorker, ToLayerWorker } from "./layer-worker-protocol.ts";
import { LayerWorkerClient } from "./layer-worker-client.ts";

/** A worker that answers each job at once with the Wasm memory `wasmBytes` says. */
class FakeWorker extends EventTarget {
  terminated = false;
  constructor(private readonly wasmBytes: () => number) {
    super();
  }
  postMessage(message: ToLayerWorker): void {
    const answer: FromLayerWorker =
      message.type === "build"
        ? { type: "built", id: message.id, file: new ArrayBuffer(4), wasmBytes: this.wasmBytes() }
        : { type: "failed", id: message.id, error: { kind: "invalidGeoJSON", error: { kind: "invalidJSON" } }, wasmBytes: this.wasmBytes() };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: answer })));
  }
  terminate(): void {
    this.terminated = true;
  }
}

const emptyContent = {
  coordinates: new Float64Array(0),
  polygons: new Uint32Array(0),
  rings: new Uint32Array(0),
  polylines: new Uint32Array(0),
  points: new Uint32Array(0),
  ids: new Float64Array(0),
  styles: new Float32Array(0),
};

describe("LayerWorkerClient", () => {
  test("the worker is ended once idle after its memory grew past what is kept, and made again for the next job", async () => {
    let memory = 1024 * 1024;
    const workers: FakeWorker[] = [];
    const client = new LayerWorkerClient(32 * 1024 * 1024, () => {
      const worker = new FakeWorker(() => memory);
      workers.push(worker);
      return worker as unknown as Worker;
    });
    await client.build(emptyContent, new Float32Array(24));
    expect(workers.length).toBe(1);
    expect(workers[0]!.terminated).toBe(false);

    // A large document read: the instance grew, and the worker goes.
    memory = 400 * 1024 * 1024;
    const outcome = await client.parse({ kind: "text", text: "not json" });
    expect(outcome).toEqual({ ok: false, error: { kind: "invalidGeoJSON", error: { kind: "invalidJSON" } } });
    expect(workers[0]!.terminated).toBe(true);
    expect(client.terminations).toBe(1);

    memory = 1024 * 1024;
    await client.build(emptyContent, new Float32Array(24));
    expect(workers.length).toBe(2);
    expect(workers[1]!.terminated).toBe(false);
    client.release();
    expect(workers[1]!.terminated).toBe(true);
  });

  test("a worker is not ended while another job waits on it", async () => {
    const workers: FakeWorker[] = [];
    const client = new LayerWorkerClient(0, () => {
      const worker = new FakeWorker(() => 1);
      workers.push(worker);
      return worker as unknown as Worker;
    });
    await Promise.all([client.build(emptyContent, new Float32Array(24)), client.build(emptyContent, new Float32Array(24))]);
    expect(workers.length).toBe(1);
    expect(client.terminations).toBe(1);
  });
});
