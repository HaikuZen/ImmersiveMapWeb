// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B9 in a worker, where the relief's tiles decode: Terrarium-encoded WebP to
// heights in metres, by each candidate, from the file's bytes to a Float32Array.

import init, { decodeTerrariumWebp } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

const toMetres = (rgba: Uint8ClampedArray | Uint8Array, size: number): Float32Array => {
  const metres = new Float32Array(size * size);
  for (let i = 0; i < metres.length; i++) metres[i] = rgba[i * 4]! * 256 + rgba[i * 4 + 1]! + rgba[i * 4 + 2]! / 256 - 32768;
  return metres;
};

async function bitmapCanvas(bytes: Uint8Array<ArrayBuffer>): Promise<Float32Array> {
  // Numbers, not colours: no premultiplication and no colour conversion.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return toMetres(context.getImageData(0, 0, size, size, { colorSpace: "srgb" }).data, size);
}

async function imageDecoder(bytes: Uint8Array<ArrayBuffer>): Promise<Float32Array> {
  const decoder = new ImageDecoder({ data: bytes, type: "image/webp", colorSpaceConversion: "none" });
  const { image } = await decoder.decode();
  const size = image.codedWidth;
  const rgba = new Uint8Array(size * size * 4);
  await image.copyTo(rgba, { format: "RGBA" });
  image.close();
  decoder.close();
  return toMetres(rgba, size);
}

self.onmessage = async (event: MessageEvent<{ tiles: Uint8Array<ArrayBuffer>[]; passes: number }>) => {
  await init();
  const { tiles, passes } = event.data;
  const candidates: Record<string, (b: Uint8Array<ArrayBuffer>) => Promise<Float32Array> | Float32Array> = {
    "createImageBitmap + OffscreenCanvas.getImageData": bitmapCanvas,
    "ImageDecoder (WebCodecs) + copyTo": imageDecoder,
    "image-webp decoder in Wasm": (b) => decodeTerrariumWebp(b),
  };
  const names = Object.keys(candidates);
  // The Wasm decoder of a lossless WebP is exact: the others are measured against it.
  const reference = tiles.map((t) => decodeTerrariumWebp(t));
  const errors: Record<string, number> = {};
  for (const name of names) {
    let worst = 0;
    for (let t = 0; t < tiles.length; t++) {
      const metres = await candidates[name]!(tiles[t]!);
      const ref = reference[t]!;
      if (metres.length !== ref.length) worst = Number.POSITIVE_INFINITY;
      else for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(metres[i]! - ref[i]!));
    }
    errors[name] = worst;
  }
  const times: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  for (let pass = 0; pass < passes + 3; pass++) {
    const order = pass % 2 ? [...names].reverse() : names;
    for (const name of order) {
      const start = performance.now();
      for (const tile of tiles) await candidates[name]!(tile);
      if (pass >= 3) times[name]!.push((performance.now() - start) / tiles.length);
    }
  }
  self.postMessage({ times, errors });
};
