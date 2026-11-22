// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The two jobs of the layers' Rust module (crates/layer-wasm), one call
 * each: a GeoJSON document into a source's flat arrays, and a source's
 * arrays with a layer's styles into the layer's mesh file. The worker runs
 * them (layer-worker.ts), and a test runs them in its own thread over the
 * same module.
 */

import type { ImmersiveMapGeoJSONError } from "../geojson/immersive-map-geojson.ts";
import type { LayerSourceBuffers } from "../sources/layer-source-content.ts";
import type { ImmersiveMapLayerSourceError } from "../sources/layer-source-data.ts";

/** A parse's result as the Rust module hands it over. */
export interface ParsedGeoJSONHandle {
  readonly ok: boolean;
  readonly errorKind: string;
  readonly errorDetail: string;
  takeCoordinates(): Float64Array<ArrayBuffer>;
  takePolygons(): Uint32Array<ArrayBuffer>;
  takeRings(): Uint32Array<ArrayBuffer>;
  takePolylines(): Uint32Array<ArrayBuffer>;
  takePoints(): Uint32Array<ArrayBuffer>;
  takeIds(): Float64Array<ArrayBuffer>;
  takeStyles(): Float32Array<ArrayBuffer>;
  free(): void;
}

/**
 * What the jobs call of the Rust module. Every array it returns is a copy
 * out of its memory, in a buffer of its own: it can be transferred whole.
 */
export interface LayerWasmModule {
  parseGeoJSON(bytes: Uint8Array): ParsedGeoJSONHandle;
  parseGeoJSONText(text: string): ParsedGeoJSONHandle;
  buildMesh(coordinates: Float64Array, polygons: Uint32Array, rings: Uint32Array, polylines: Uint32Array, points: Uint32Array, styles: Float32Array, layerStyles: Float32Array): Uint8Array<ArrayBuffer>;
  wasmMemoryBytes(): number;
}

export type LayerParseOutcome = { readonly ok: true; readonly buffers: LayerSourceBuffers } | { readonly ok: false; readonly error: ImmersiveMapLayerSourceError };

/** Reads a document's text or bytes into a source's arrays, or the error the document is. */
export function parseLayerDocument(wasm: LayerWasmModule, document: string | Uint8Array): LayerParseOutcome {
  const parsed = typeof document === "string" ? wasm.parseGeoJSONText(document) : wasm.parseGeoJSON(document);
  try {
    if (!parsed.ok) return { ok: false, error: { kind: "invalidGeoJSON", error: geoJSONError(parsed.errorKind, parsed.errorDetail) } };
    const buffers: LayerSourceBuffers = {
      coordinates: parsed.takeCoordinates(),
      polygons: parsed.takePolygons(),
      rings: parsed.takeRings(),
      polylines: parsed.takePolylines(),
      points: parsed.takePoints(),
      ids: parsed.takeIds(),
      styles: parsed.takeStyles(),
    };
    return { ok: true, buffers };
  } finally {
    parsed.free();
  }
}

/** A layer's mesh file from its source's arrays and its styles (`layerStyleValues`), in a buffer of its own. */
export function buildLayerMesh(wasm: LayerWasmModule, content: LayerSourceBuffers, styles: Float32Array): ArrayBuffer {
  const file = wasm.buildMesh(content.coordinates, content.polygons, content.rings, content.polylines, content.points, content.styles, styles);
  return file.byteOffset === 0 && file.byteLength === file.buffer.byteLength ? file.buffer : file.slice().buffer;
}

function geoJSONError(kind: string, detail: string): ImmersiveMapGeoJSONError {
  if (kind === "unknownType") return { kind: "unknownType", type: detail };
  if (kind === "invalidCoordinates") return { kind: "invalidCoordinates", path: detail };
  return { kind: "invalidJSON" };
}
