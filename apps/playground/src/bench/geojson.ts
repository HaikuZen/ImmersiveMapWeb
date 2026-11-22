// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B11: a GeoJSON FeatureCollection of 10 MB and of 100 MB parsed in a worker
// into flat coordinates in Wasm: JSON.parse and a walk, serde_json, simd-json.
// The memory column is the worker's whole footprint with the result held
// (measureUserAgentSpecificMemory), and the Wasm memory each grew to.

import { done, fail, publish, stat } from "./harness.ts";

/** A deterministic FeatureCollection of about `megabytes`: lines, polygons and points with a few properties. */
function makeGeoJSON(megabytes: number): Uint8Array<ArrayBuffer> {
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const parts: string[] = [];
  let size = 0;
  const coordinate = (x: number, y: number) => `[${x.toFixed(6)},${y.toFixed(6)}]`;
  for (let i = 0; size < megabytes * 1e6; i++) {
    const kind = rand();
    let x = 37 + rand(), y = 55 + rand();
    let geometry: string;
    if (kind < 0.6) {
      const points: string[] = [];
      for (let p = 0; p < 20; p++) points.push(coordinate((x += (rand() - 0.5) * 1e-3), (y += (rand() - 0.5) * 1e-3)));
      geometry = `{"type":"LineString","coordinates":[${points.join(",")}]}`;
    } else if (kind < 0.9) {
      const ring: string[] = [];
      for (let p = 0; p < 30; p++) ring.push(coordinate(x + Math.cos((p / 30) * Math.PI * 2) * 1e-3, y + Math.sin((p / 30) * Math.PI * 2) * 1e-3));
      ring.push(ring[0]!);
      geometry = `{"type":"Polygon","coordinates":[[${ring.join(",")}]]}`;
    } else geometry = `{"type":"Point","coordinates":${coordinate(x, y)}}`;
    const feature = `{"type":"Feature","geometry":${geometry},"properties":{"id":${i},"name":"feature ${i}","kind":"${kind < 0.6 ? "road" : kind < 0.9 ? "area" : "poi"}","value":${(rand() * 1000).toFixed(2)}}}`;
    parts.push(feature);
    size += feature.length + 1;
  }
  return new TextEncoder().encode(`{"type":"FeatureCollection","features":[${parts.join(",")}]}`) as Uint8Array<ArrayBuffer>;
}

async function measure(variant: string, bytes: Uint8Array<ArrayBuffer>, runs: number) {
  const worker = new Worker(new URL("./geojson-worker.ts", import.meta.url), { type: "module" });
  const result = await new Promise<{ times: number[]; coordinates: number; wasmBytes: number }>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ variant, bytes, runs });
  });
  let footprint: number | undefined;
  try {
    const memory = await (performance as unknown as { measureUserAgentSpecificMemory(): Promise<{ bytes: number }> }).measureUserAgentSpecificMemory();
    footprint = memory.bytes;
  } catch {
    footprint = undefined;
  }
  worker.terminate();
  return { ...result, footprint };
}

async function run() {
  const rows: (string | number)[][] = [];
  const raw: unknown[] = [];
  for (const [megabytes, runs] of [[10, 6], [100, 3]] as const) {
    const bytes = makeGeoJSON(megabytes);
    for (const variant of ["JSON.parse + flatten + copy into Wasm", "serde_json in Wasm", "simd-json in Wasm"]) {
      const r = await measure(variant, bytes, runs);
      // The first run warms the worker up: the median of the rest.
      const s = stat(r.times.slice(1));
      rows.push([`${(bytes.length / 1e6).toFixed(0)} MB`, variant, s.median, r.coordinates, r.footprint === undefined ? "n/a" : (r.footprint / 1e6).toFixed(0), (r.wasmBytes / 1e6).toFixed(0)]);
      raw.push({ megabytes: bytes.length / 1e6, variant, ...r });
    }
  }
  publish("B11: GeoJSON to flat coordinates in Wasm, in a worker", ["size", "path", "ms (median)", "coordinates", "page memory with result, MB", "Wasm memory, MB"], rows, raw);
  done();
}

run().catch(fail);
