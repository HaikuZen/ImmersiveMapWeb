// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The messages between the map and the layers' worker (layer-worker.ts). The
 * worker reads a GeoJSON document into a source's flat arrays and builds a
 * layer's mesh from them, both in Rust (crates/layer-wasm). Everything that
 * comes back is a flat buffer, transferred: the arrays of a source
 * (`LayerSourceBuffers`) and a mesh as its file (`LayerMeshFile`).
 */

import type { ImmersiveMapLayerSourceError } from "../sources/layer-source-data.ts";
import type { LayerSourceBuffers } from "../sources/layer-source-content.ts";

/** A GeoJSON document for the worker to read: at a URL (absolute), as text, as UTF-8 bytes or as a parsed object. */
export type LayerDocument =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "object"; readonly object: object };

export type ToLayerWorker =
  | { readonly type: "parse"; readonly id: number; readonly document: LayerDocument }
  /** `styles` is the layer's `layerStyleValues`. */
  | { readonly type: "build"; readonly id: number; readonly content: LayerSourceBuffers; readonly styles: Float32Array };

export type FromLayerWorker =
  | { readonly type: "parsed"; readonly id: number; readonly buffers: LayerSourceBuffers; readonly inputBytes: number; readonly wasmBytes: number }
  | { readonly type: "failed"; readonly id: number; readonly error: ImmersiveMapLayerSourceError; readonly wasmBytes: number }
  | { readonly type: "built"; readonly id: number; readonly file: ArrayBuffer; readonly wasmBytes: number };

/** The transferable buffers of a source's arrays. */
export function layerSourceTransferables(buffers: LayerSourceBuffers): ArrayBuffer[] {
  return [buffers.coordinates.buffer, buffers.polygons.buffer, buffers.rings.buffer, buffers.polylines.buffer, buffers.points.buffer, buffers.ids.buffer, buffers.styles.buffer];
}
