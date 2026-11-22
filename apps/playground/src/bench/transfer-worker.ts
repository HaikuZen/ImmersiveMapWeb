// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B3, the worker side: prepares every fixture tile once with the Rust
// preparer, then hands tile k to the main thread on request, in the mode
// asked: a transferred buffer, a structured-clone copy, or a copy into a
// SharedArrayBuffer the main thread reads.

import init, { TilePreparer } from "../../../../packages/immersive-map/src/wasm/worker_wasm/worker_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

let prepared: { vertices: Uint32Array; indices: Uint32Array }[] = [];
let shared: Uint8Array | undefined;

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (message.type === "init") {
    await init();
    const preparer = new TilePreparer();
    prepared = message.tiles.map((t: { z: number; bytes: Uint8Array }) => {
      const p = preparer.prepare(t.bytes, t.z);
      const result = { vertices: p.takeVertices(), indices: p.takeIndices() };
      p.free();
      return result;
    });
    const largest = Math.max(...prepared.map((p) => p.vertices.byteLength + p.indices.byteLength));
    shared = new Uint8Array(new SharedArrayBuffer(largest));
    self.postMessage({ type: "ready", shared: shared.buffer, sizes: prepared.map((p) => p.vertices.byteLength + p.indices.byteLength) });
    return;
  }
  const tile = prepared[message.index]!;
  const sentAt = performance.timeOrigin + performance.now();
  if (message.mode === "transfer") {
    // A worker that transfers gives its copy away, so it sends fresh copies (as a parser's output would be).
    const v = tile.vertices.slice();
    const i = tile.indices.slice();
    const start = performance.timeOrigin + performance.now();
    self.postMessage({ type: "tile", sentAt: start, v: v.buffer, i: i.buffer }, [v.buffer, i.buffer]);
  } else if (message.mode === "clone") {
    self.postMessage({ type: "tile", sentAt, v: tile.vertices.buffer, i: tile.indices.buffer });
  } else {
    shared!.set(new Uint8Array(tile.vertices.buffer, tile.vertices.byteOffset, tile.vertices.byteLength), 0);
    shared!.set(new Uint8Array(tile.indices.buffer, tile.indices.byteOffset, tile.indices.byteLength), tile.vertices.byteLength);
    self.postMessage({ type: "tile", sentAt, vLength: tile.vertices.byteLength, iLength: tile.indices.byteLength });
  }
};
