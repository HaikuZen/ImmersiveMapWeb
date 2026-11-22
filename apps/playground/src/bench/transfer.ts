// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B3: the time the main thread spends getting one prepared tile into GPU
// buffers, and the latency from the worker's post to the buffers existing.

import { done, fail, fixtureBytes, gunzip, manifest, publish, stat } from "./harness.ts";

type Mode = "transfer" | "clone" | "shared";
type Upload = "writeBuffer" | "mappedAtCreation";

async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const { tiles } = await manifest();
  const loaded = await Promise.all(tiles.map(async (t) => ({ z: t.z, bytes: await gunzip(await fixtureBytes(t.file)) })));
  const worker = new Worker(new URL("./transfer-worker.ts", import.meta.url), { type: "module" });

  let onTile: (data: any) => void = () => {};
  const ready = new Promise<{ shared: SharedArrayBuffer; sizes: number[] }>((resolve) => {
    worker.onmessage = (e) => (e.data.type === "ready" ? resolve(e.data) : onTile(e.data));
  });
  worker.postMessage({ type: "init", tiles: loaded });
  const { shared, sizes } = await ready;
  const sharedBytes = new Uint8Array(shared);

  const make = (source: BufferSource | Uint8Array<SharedArrayBuffer>, usage: number, upload: Upload) => {
    const view = ArrayBuffer.isView(source) ? source : new Uint8Array(source as ArrayBuffer);
    const size = Math.max(16, Math.ceil(view.byteLength / 4) * 4);
    if (upload === "mappedAtCreation") {
      const buffer = device.createBuffer({ size, usage, mappedAtCreation: true });
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      buffer.unmap();
      return buffer;
    }
    const buffer = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
    return buffer;
  };

  const passes = Number(new URLSearchParams(location.search).get("passes") ?? 15);
  const combos: [Mode, Upload][] = [
    ["transfer", "writeBuffer"],
    ["transfer", "mappedAtCreation"],
    ["clone", "writeBuffer"],
    ["shared", "writeBuffer"],
    ["shared", "mappedAtCreation"],
  ];
  const mainTimes: Record<string, number[]> = {};
  const latencies: Record<string, number[]> = {};
  for (let pass = 0; pass < passes + 2; pass++) {
    for (const [mode, upload] of pass % 2 ? [...combos].reverse() : combos) {
      const key = `${mode} + ${upload}`;
      const buffers: GPUBuffer[] = [];
      for (let index = 0; index < loaded.length; index++) {
        const data = await new Promise<any>((resolve) => {
          onTile = resolve;
          worker.postMessage({ index, mode });
        });
        const start = performance.now();
        if (mode === "shared") {
          buffers.push(make(sharedBytes.subarray(0, data.vLength), GPUBufferUsage.VERTEX, upload));
          buffers.push(make(sharedBytes.subarray(data.vLength, data.vLength + data.iLength), GPUBufferUsage.INDEX, upload));
        } else {
          buffers.push(make(data.v, GPUBufferUsage.VERTEX, upload));
          buffers.push(make(data.i, GPUBufferUsage.INDEX, upload));
        }
        const end = performance.now();
        if (pass >= 2) {
          (mainTimes[key] ??= []).push(end - start);
          (latencies[key] ??= []).push(performance.timeOrigin + end - data.sentAt);
        }
      }
      await device.queue.onSubmittedWorkDone();
      for (const b of buffers) b.destroy();
    }
  }
  const megabytes = sizes.reduce((a, b) => a + b, 0) / 1e6;
  publish(
    `B3: ${loaded.length} prepared tiles (${megabytes.toFixed(1)} MB) handed one by one from a worker to GPU buffers`,
    ["path", "main ms/tile median", "main ms/tile p95", "latency ms median", "latency ms p95"],
    Object.keys(mainTimes).map((k) => {
      const m = stat(mainTimes[k]!);
      const l = stat(latencies[k]!);
      return [k, m.median, m.p95, l.median, l.p95];
    }),
    { mainTimes, latencies },
  );
  done();
}

run().catch(fail);
