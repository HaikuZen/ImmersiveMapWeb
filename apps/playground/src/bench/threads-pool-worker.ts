// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B17, the many-instances side: one of N workers, each with its own instance
// of the map's worker module, parsing the tiles it is handed.

import init, { TileParser } from "../../../../packages/immersive-map/src/wasm/worker_wasm/worker_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

let parser: TileParser | undefined;

self.onmessage = async (event: MessageEvent<{ tiles: { bytes: Uint8Array; z: number; x: number; y: number }[] } | "init">) => {
  if (event.data === "init") {
    await init();
    parser = new TileParser(JSON.stringify({ options: { labelsEnabled: true, buildingMinimumSourceZoom: 14 } }));
    self.postMessage("ready");
    return;
  }
  let arena = 0;
  for (const t of event.data.tiles) {
    const parsed = parser!.parse(t.bytes, t.z, t.x, t.y);
    arena += parsed.takeArena().byteLength;
    parsed.free();
  }
  self.postMessage(arena);
};
