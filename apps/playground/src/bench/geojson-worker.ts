// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B11 in a worker: one candidate per worker, so the Wasm memory each grows to
// is its own. The bytes of a FeatureCollection to flat coordinates in Wasm,
// the place the layers' tessellation reads them from.

import init, { geojsonSerde, geojsonSimd, keepCoordinates, wasmMemoryBytes } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

type Position = [number, number];
interface Feature {
  geometry: { type: string; coordinates: Position | Position[] | Position[][] | Position[][][] };
  properties: Record<string, unknown> | null;
}

/** Kept until the worker ends: what a layer holds after its parse. */
let kept: unknown;

function jsonParse(bytes: Uint8Array<ArrayBuffer>): number {
  const collection = JSON.parse(new TextDecoder().decode(bytes)) as { features: Feature[] };
  let count = 0;
  const walk = (c: unknown, out: Float64Array | undefined): void => {
    const a = c as unknown[];
    if (typeof a[0] === "number") {
      if (out) {
        out[count] = a[0];
        out[count + 1] = a[1] as number;
      }
      count += 2;
    } else for (const inner of a) walk(inner, out);
  };
  for (const f of collection.features) walk(f.geometry.coordinates, undefined);
  const out = new Float64Array(count);
  count = 0;
  for (const f of collection.features) walk(f.geometry.coordinates, out);
  kept = collection;
  return keepCoordinates(out);
}

self.onmessage = async (event: MessageEvent<{ variant: string; bytes: Uint8Array<ArrayBuffer>; runs: number }>) => {
  await init();
  const { variant, bytes, runs } = event.data;
  const run = { "JSON.parse + flatten + copy into Wasm": jsonParse, "serde_json in Wasm": (b: Uint8Array) => geojsonSerde(b), "simd-json in Wasm": (b: Uint8Array) => geojsonSimd(b) }[variant]!;
  const times: number[] = [];
  let coordinates = 0;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    coordinates = run(bytes);
    times.push(performance.now() - start);
  }
  self.postMessage({ times, coordinates, wasmBytes: wasmMemoryBytes(), keptSomething: kept !== undefined });
};
