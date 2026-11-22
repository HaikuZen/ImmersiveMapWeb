// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B17, the shared-memory side: one Wasm instance whose rayon pool parses the
// whole set (wasm-bindgen-rayon starts the pool's own workers).

import init, { initThreadPool, PooledParser } from "../../../../packages/immersive-map/src/wasm/bench_rayon/bench_rayon.js";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; ends: Uint32Array; zxy: Int32Array; threads: number; passes: number }>) => {
  const { bytes, ends, zxy, threads, passes } = event.data;
  try {
  await init();
  await initThreadPool(threads);
  const parser = new PooledParser();
  const times: number[] = [];
  for (let pass = 0; pass < passes + 2; pass++) {
    const start = performance.now();
    parser.parseAll(bytes, ends, zxy);
    if (pass >= 2) times.push(performance.now() - start);
  }
  self.postMessage({ times });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
