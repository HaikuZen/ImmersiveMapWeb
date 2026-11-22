// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

/**
 * The layers' worker: reads the GeoJSON documents of the app's sources and
 * builds the meshes of its layers, in Rust (crates/layer-wasm, decision B11:
 * `serde_json` in Wasm). A worker of its own, apart from the tile workers,
 * so the memory a large document grows its Wasm instance to is given back
 * to the system when the map ends the worker (`LayerWorkerClient`). Each
 * answer goes back as transferred buffers and says how large the instance's
 * memory has grown.
 */

import init, * as layerWasm from "../../wasm/layer_wasm/layer_wasm.js";
import type { ImmersiveMapLayerSourceError } from "../sources/layer-source-data.ts";
import { buildLayerMesh, type LayerWasmModule, parseLayerDocument } from "./layer-jobs.ts";
import { type FromLayerWorker, type LayerDocument, layerSourceTransferables, type ToLayerWorker } from "./layer-worker-protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

const wasm = layerWasm as unknown as LayerWasmModule;
const ready = init();

/** The document's text or bytes: fetched for a URL, written out for an object. */
async function documentInput(document: LayerDocument): Promise<string | Uint8Array> {
  switch (document.kind) {
    case "url": {
      const response = await fetch(document.url);
      if (!response.ok) throw unreadable(`HTTP ${response.status} for ${document.url}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    case "text":
      return document.text;
    case "bytes":
      return document.bytes;
    case "object":
      return JSON.stringify(document.object);
  }
}

function unreadable(reason: string): ImmersiveMapLayerSourceError {
  return { kind: "unreadableFile", reason };
}

function isSourceError(value: unknown): value is ImmersiveMapLayerSourceError {
  return typeof value === "object" && value !== null && "kind" in value;
}

async function handle(message: ToLayerWorker): Promise<void> {
  try {
    await ready;
  } catch (error) {
    self.postMessage({ type: "failed", id: message.id, error: unreadable(`the layers' Wasm module did not load: ${String(error)}`), wasmBytes: 0 } satisfies FromLayerWorker);
    return;
  }
  try {
    if (message.type === "build") {
      const file = buildLayerMesh(wasm, message.content, message.styles);
      self.postMessage({ type: "built", id: message.id, file, wasmBytes: wasm.wasmMemoryBytes() } satisfies FromLayerWorker, [file]);
      return;
    }
    const input = await documentInput(message.document);
    const inputBytes = typeof input === "string" ? input.length : input.byteLength;
    const outcome = parseLayerDocument(wasm, input);
    if (!outcome.ok) {
      self.postMessage({ type: "failed", id: message.id, error: outcome.error, wasmBytes: wasm.wasmMemoryBytes() } satisfies FromLayerWorker);
      return;
    }
    self.postMessage({ type: "parsed", id: message.id, buffers: outcome.buffers, inputBytes, wasmBytes: wasm.wasmMemoryBytes() } satisfies FromLayerWorker, layerSourceTransferables(outcome.buffers));
  } catch (error) {
    const failure = isSourceError(error) ? error : unreadable(error instanceof Error ? error.message : String(error));
    self.postMessage({ type: "failed", id: message.id, error: failure, wasmBytes: wasm.wasmMemoryBytes() } satisfies FromLayerWorker);
  }
}

self.onmessage = (event: MessageEvent<ToLayerWorker>) => void handle(event.data);
