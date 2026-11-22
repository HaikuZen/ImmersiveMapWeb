// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B10, the CPU candidate in a worker, as the engine's tile workers would run
// it: the Rust port of the Swift `GroundReliefOcclusion` in Wasm
// (crates/bench-wasm/src/occlusion.rs, over the engine's decoder in
// crates/ground-relief). The tiles are decoded once up front, then each
// tile's occlusion is timed two ways: from halves handed in from JavaScript
// (copied into Wasm, bytes out, the recompute of a tile under a new key) and
// from the halves the decode keeps in Wasm (the computation beside the decode).

import init, { BenchTerrain, terrainOcclusion } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";
import init_, { decodeTerrainTile } from "../../../../packages/immersive-map/src/wasm/worker_wasm/worker_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

interface Request {
  tiles: { bytes: Uint8Array<ArrayBuffer>; z: number; x: number; y: number }[];
  key: { radiusMetres: number; directions: number; resolution: number };
  warmup: number;
  iterations: number;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  await Promise.all([init(), init_()]);
  const { tiles, key, warmup, iterations } = event.data;
  // Decoded as the tile workers decode them (crates/worker-wasm).
  const decoded = tiles.map((t) => decodeTerrainTile(t.bytes, 0));
  const sizes = decoded.map((d) => d.size);
  const halves = decoded.map((d) => d.takeHalves());
  const kept = tiles.map((t) => new BenchTerrain(t.bytes));
  const run = (i: number) => terrainOcclusion(halves[i]!, sizes[i]!, tiles[i]!.z, tiles[i]!.y, key.radiusMetres, key.directions, key.resolution);
  const runKept = (i: number) => kept[i]!.computeOcclusion(tiles[i]!.z, tiles[i]!.y, key.radiusMetres, key.directions, key.resolution);
  const reference = tiles.map((_, i) => run(i));
  const copyIn: number[] = [];
  const inWasm: number[] = [];
  for (let pass = 0; pass < warmup + iterations; pass++) {
    for (let i = 0; i < tiles.length; i++) {
      // Alternated, so neither path always runs on a warmer cache.
      const order = (pass + i) % 2 ? [run, runKept] : [runKept, run];
      for (const candidate of order) {
        const start = performance.now();
        candidate(i);
        const elapsed = performance.now() - start;
        if (pass >= warmup) (candidate === run ? copyIn : inWasm).push(elapsed);
      }
    }
  }
  self.postMessage(
    { halves, sizes, reference, copyIn, inWasm },
    [...halves.map((h) => h.buffer), ...reference.map((r) => r.buffer)],
  );
};
