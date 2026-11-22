// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import * as layerWasm from "../../wasm/layer_wasm/layer_wasm.js";
import { LayerMeshDiskCache } from "../cache/layer-mesh-disk-cache.ts";
import type { LayerWasmModule } from "../worker/layer-jobs.ts";
import { InProcessLayerJobs } from "../worker/layer-worker-client.ts";

/** The layers' Rust module as the tests call it, loaded by tests/setup/layer-wasm.ts. */
export const testLayerWasm = layerWasm as unknown as LayerWasmModule;

/** The worker's jobs run in the test's thread, a document at a URL read from `documents` (a missing one is unreadable). */
export function testLayerJobs(documents: Readonly<Record<string, string>> = {}): InProcessLayerJobs {
  return new InProcessLayerJobs(testLayerWasm, (url) => {
    const text = documents[url];
    return text === undefined ? Promise.reject(new Error(`no such document: ${url}`)) : Promise.resolve(new TextEncoder().encode(text));
  });
}

/** A disk cache that keeps nothing. */
export const noMeshCache = (): LayerMeshDiskCache => new LayerMeshDiskCache(0);
