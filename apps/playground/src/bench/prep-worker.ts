// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B1 runs here, in a worker as the library does: each fixture tile prepared
// by the Rust/Wasm preparer (including the copy out to JS arrays a worker
// must make to transfer the result) and by its TypeScript twin, alternating
// per pass so that drift hits both alike.

import init, { TilePreparer } from "../../../../packages/immersive-map/src/wasm/worker_wasm/worker_wasm.js";
import { TsPreparer } from "./ts-prep.ts";

declare const self: DedicatedWorkerGlobalScope;

interface Job {
  tiles: { set: string; z: number; bytes: Uint8Array }[];
  passes: number;
  warmup: number;
}

self.onmessage = async (event: MessageEvent<Job>) => {
  await init();
  const { tiles, passes, warmup } = event.data;
  const rust = new TilePreparer();
  const ts = new TsPreparer();

  const runRust = (t: Job["tiles"][number]) => {
    const prepared = rust.prepare(t.bytes, t.z);
    const v = prepared.takeVertices();
    const i = prepared.takeIndices();
    prepared.free();
    return [v.length, i.length] as const;
  };
  const runTs = (t: Job["tiles"][number]) => {
    const prepared = ts.prepare(t.bytes, t.z);
    return [prepared.vertices.length, prepared.indices.length] as const;
  };

  // Same output? Vertex words must match exactly; index counts may differ
  // only if the two earcut ports triangulate a degenerate ring differently.
  const mismatches: string[] = [];
  for (const t of tiles) {
    const [rv, ri] = runRust(t);
    const [tv, ti] = runTs(t);
    if (rv !== tv || ri !== ti) mismatches.push(`${t.set} z${t.z}: rust ${rv}/${ri} ts ${tv}/${ti}`);
  }

  const rustTimes = tiles.map(() => [] as number[]);
  const tsTimes = tiles.map(() => [] as number[]);
  for (let pass = 0; pass < warmup + passes; pass++) {
    const rustFirst = pass % 2 === 0;
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k]!;
      for (const which of rustFirst ? ["rust", "ts"] : ["ts", "rust"]) {
        const start = performance.now();
        if (which === "rust") runRust(t);
        else runTs(t);
        const elapsed = performance.now() - start;
        if (pass >= warmup) (which === "rust" ? rustTimes : tsTimes)[k]!.push(elapsed);
      }
    }
  }
  self.postMessage({ rustTimes, tsTimes, mismatches });
};
