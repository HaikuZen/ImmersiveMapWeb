// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B10: the terrain's occlusion of the sky (the Swift `GroundReliefOcclusion`)
// for the 27 Mapterhorn tiles of the fixtures, under the style's default key
// (3000 m, 8 directions, 128 points a side). The CPU candidate is the Rust
// port in a worker's Wasm (occlusion-worker.ts), the GPU candidate the
// engine's compute shader over the r16float height texture the relief
// already uploads for drawing (tile/relief/store/ground-relief-occlusion-gpu.ts).
// The GPU's bytes are checked against the CPU's.

import { done, fail, fixtureBytes, manifest, publish, stat } from "./harness.ts";
import { GroundReliefOcclusionGpu, type GroundReliefOcclusionGpuKey } from "../../../../packages/immersive-map/src/tile/relief/store/ground-relief-occlusion-gpu.ts";

interface CpuResult {
  halves: Uint16Array<ArrayBuffer>[];
  sizes: number[];
  reference: Uint8Array<ArrayBuffer>[];
  copyIn: number[];
  inWasm: number[];
}

const query = new URLSearchParams(location.search);
const iterations = Number(query.get("iterations") ?? 50);
const warmup = Number(query.get("warmup") ?? 5);
const key: GroundReliefOcclusionGpuKey = {
  radiusMetres: Number(query.get("radius") ?? 3000),
  directions: Number(query.get("directions") ?? 8),
  resolution: Number(query.get("resolution") ?? 128),
};

async function readBack(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const resolution = texture.width;
  const rowBytes = Math.ceil(resolution / 256) * 256;
  const buffer = device.createBuffer({ size: rowBytes * resolution, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: rowBytes }, [resolution, resolution]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buffer.getMappedRange());
  const bytes = new Uint8Array(resolution * resolution);
  for (let row = 0; row < resolution; row++) bytes.set(padded.subarray(row * rowBytes, row * rowBytes + resolution), row * resolution);
  buffer.destroy();
  return bytes;
}

async function run() {
  const all = await manifest();
  const fixtures = all.terrainTiles;
  const bytes = await Promise.all(fixtures.map((t) => fixtureBytes(t.file)));
  const tiles = fixtures.map((t, i) => ({ bytes: bytes[i]!, z: t.z, x: t.x, y: t.y }));

  const worker = new Worker(new URL("./occlusion-worker.ts", import.meta.url), { type: "module" });
  const cpu = await new Promise<CpuResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<CpuResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ tiles, key, warmup, iterations });
  });
  worker.terminate();

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("B10 needs WebGPU");
  const timestamps = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ["timestamp-query"] : [] });
  const gpu = new GroundReliefOcclusionGpu(device);

  // The heights as the relief uploads them for drawing: not part of the measurement.
  const heights = cpu.halves.map((halves, i) => {
    const size = cpu.sizes[i]!;
    const texture = device.createTexture({ size: [size, size], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture }, halves, { bytesPerRow: size * 2 }, [size, size]);
    return texture;
  });

  // The GPU's bytes against the CPU's.
  let maxDifference = 0;
  let differing = 0;
  let total = 0;
  for (let i = 0; i < tiles.length; i++) {
    const texture = gpu.compute(heights[i]!, tiles[i]!, key);
    const out = await readBack(device, texture);
    texture.destroy();
    const reference = cpu.reference[i]!;
    for (let j = 0; j < reference.length; j++) {
      const d = Math.abs(out[j]! - reference[j]!);
      if (d > 0) differing++;
      maxDifference = Math.max(maxDifference, d);
    }
    total += reference.length;
  }

  // Per tile as the engine would run it: encoded and submitted on its own,
  // the wall time to onSubmittedWorkDone and the main thread's share.
  const wall: number[] = [];
  const submit: number[] = [];
  for (let pass = 0; pass < warmup + iterations; pass++) {
    for (let i = 0; i < tiles.length; i++) {
      const start = performance.now();
      const texture = gpu.compute(heights[i]!, tiles[i]!, key);
      const submitted = performance.now();
      await device.queue.onSubmittedWorkDone();
      const end = performance.now();
      texture.destroy();
      if (pass >= warmup) {
        wall.push(end - start);
        submit.push(submitted - start);
      }
    }
  }

  // GPU time by timestamp-query, each tile's pass, the 27 tiles in one submit.
  const gpuPerTile: number[] = [];
  if (timestamps) {
    const count = tiles.length;
    const querySet = device.createQuerySet({ type: "timestamp", count: count * 2 });
    const resolve = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let pass = 0; pass < warmup + iterations; pass++) {
      const read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const textures = tiles.map((t, i) => gpu.encode(encoder, heights[i]!, t, key, { querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 }));
      encoder.resolveQuerySet(querySet, 0, count * 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, count * 16);
      device.queue.submit([encoder.finish()]);
      gpu.submitted();
      await read.mapAsync(GPUMapMode.READ);
      const times = new BigInt64Array(read.getMappedRange());
      if (pass >= warmup) for (let i = 0; i < count; i++) gpuPerTile.push(Number(times[i * 2 + 1]! - times[i * 2]!) / 1e6);
      read.destroy();
      for (const texture of textures) texture.destroy();
    }
  }

  const rows: (string | number)[][] = [];
  const row = (name: string, samples: number[]) => {
    const s = stat(samples);
    rows.push([name, s.median, s.p95, s.n]);
  };
  row("CPU: Wasm in a worker, halves copied in, bytes out", cpu.copyIn);
  row("CPU: Wasm in a worker, halves kept from the decode", cpu.inWasm);
  row("GPU: submit to onSubmittedWorkDone (wall)", wall);
  row("GPU: main thread, encode and submit", submit);
  if (timestamps) {
    row("GPU: compute pass, timestamp-query", gpuPerTile);
  }
  publish(
    `B10: ms per terrain tile, ${tiles.length} tiles, key ${key.radiusMetres} m / ${key.directions} directions / ${key.resolution}², GPU vs CPU bytes: max difference ${maxDifference}, ${differing} of ${total} differ`,
    ["path", "ms per tile (median)", "p95", "samples"],
    rows,
    { key, maxDifference, differing, total, timestamps, adapter: adapter.info, cpu: { copyIn: cpu.copyIn, inWasm: cpu.inWasm }, wall, submit, gpuPerTile },
  );
  done();
}

run().catch(fail);
