// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B2 in a worker: every fixture tile's gzip bytes inflated by each candidate,
// each path ending where the Wasm tile parser can read the bytes.

import init, { copyIn, inflateMiniz, inflateZlibRs } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

async function streamBlob(bytes: Uint8Array<ArrayBuffer>) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return copyIn(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function streamWriter(bytes: Uint8Array<ArrayBuffer>) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return copyIn(new Uint8Array(await new Response(ds.readable).arrayBuffer()));
}

self.onmessage = async (event: MessageEvent<{ tiles: Uint8Array<ArrayBuffer>[]; passes: number }>) => {
  await init();
  const { tiles, passes } = event.data;
  const candidates: Record<string, (b: Uint8Array<ArrayBuffer>) => unknown> = {
    "DecompressionStream (Blob) + copy into Wasm": streamBlob,
    "DecompressionStream (writer) + copy into Wasm": streamWriter,
    "miniz_oxide in Wasm": (b) => inflateMiniz(b),
    "zlib-rs in Wasm": (b) => inflateZlibRs(b),
  };
  const names = Object.keys(candidates);
  // times[candidate][pass] = ms to inflate the whole set once.
  const times: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  for (let pass = 0; pass < passes + 3; pass++) {
    const order = pass % 2 ? [...names].reverse() : names;
    for (const name of order) {
      const run = candidates[name]!;
      const start = performance.now();
      for (const tile of tiles) await run(tile);
      if (pass >= 3) times[name]!.push(performance.now() - start);
    }
  }
  self.postMessage(times);
};
