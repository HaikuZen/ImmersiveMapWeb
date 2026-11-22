// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B14 in a worker, where the engine decodes its model tiles: the inflated
// tile's bytes to what the main thread uploads, by each texture candidate.
// The time is the worker's whole call: the copy into Wasm, the decode and
// checks, the texture's preparation and the copies of every block out of
// Wasm memory. The blocks are then transferred to the main thread.

import initModels, { decodeModelTile } from "../../../../packages/immersive-map/src/wasm/model_wasm/model_wasm.js";
import initBench, { astcToBc7 } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

export type Variant = "astc" | "rgba8" | "bc7";

export interface Tile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  z: number;
  x: number;
  y: number;
}

export interface LevelLayout {
  width: number;
  height: number;
  bytesPerRow: number;
  rowsPerImage: number;
  layerByteCount: number;
  byteOffset: number;
}

export interface TextureLayout {
  format: "astc" | "rgba8" | "bc7";
  width: number;
  height: number;
  mipLevelCount: number;
  layerCount: number;
  blockEdge: number;
  levels: LevelLayout[];
}

export interface Decoded {
  ms: number;
  vertices: Uint8Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  texture: Uint8Array<ArrayBuffer>;
  layout: TextureLayout;
}

export type Request = { tiles: Tile[] } | { tile: number; variant: Variant };

/** The BC7 layout of a texture: 4x4 blocks of 16 bytes, in the stored order. */
function bc7Layout(texture: TextureLayout): TextureLayout {
  let offset = 0;
  const levels = texture.levels.map(({ width, height }) => {
    const across = Math.ceil(width / 4);
    const down = Math.ceil(height / 4);
    const layerByteCount = across * down * 16;
    const level = { width, height, bytesPerRow: across * 16, rowsPerImage: down, layerByteCount, byteOffset: offset };
    offset += layerByteCount * texture.layerCount;
    return level;
  });
  return { ...texture, format: "bc7", blockEdge: 4, levels };
}

let tiles: Tile[] = [];
const ready = Promise.all([initModels(), initBench()]);

function decode(tile: Tile, variant: Variant): Decoded {
  const start = performance.now();
  const decoded = decodeModelTile(tile.bytes, tile.z, tile.x, tile.y, variant === "rgba8" ? 1 : 0);
  const meta = JSON.parse(decoded.meta) as { texture: TextureLayout };
  const vertices = decoded.takeVertices() as Uint8Array<ArrayBuffer>;
  const indices = decoded.takeIndices() as Uint32Array<ArrayBuffer>;
  let texture = decoded.takeTexture() as Uint8Array<ArrayBuffer>;
  decoded.free();
  let layout = meta.texture;
  if (variant === "bc7") {
    // If BC7 won, it would be a third mode of decodeModelTile: here the
    // stored blocks make one extra trip into the bench module, about
    // 0.2 MB, a few hundredths of a millisecond.
    const { width, height, mipLevelCount, layerCount, blockEdge } = layout;
    texture = astcToBc7(texture, width, height, mipLevelCount, layerCount, blockEdge) as Uint8Array<ArrayBuffer>;
    layout = bc7Layout(layout);
  }
  return { ms: performance.now() - start, vertices, indices, texture, layout };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  await ready;
  const request = event.data;
  if ("tiles" in request) {
    tiles = request.tiles;
    self.postMessage("ready");
    return;
  }
  try {
    const decoded = decode(tiles[request.tile]!, request.variant);
    self.postMessage(decoded, [decoded.vertices.buffer, decoded.indices.buffer, decoded.texture.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
