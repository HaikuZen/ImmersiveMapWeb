// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B14: the textures of the model tiles, which the archive stores as ASTC
// (8x8 blocks, 512 x 512, 10 mips, 1 or 2 layers). Three full paths per
// tile, as the engine runs them: the worker decodes (models-worker.ts) and
// the main thread uploads.
//   astc:  the blocks as stored, an `astc-8x8-unorm` 2d-array texture.
//   rgba8: decoded to RGBA8 in Wasm, an `rgba8unorm` texture.
//   bc7:   decoded to RGBA8 and encoded as BC7 in Wasm, a `bc7-rgba-unorm` texture.
// Every level and layer is one `queue.writeTexture`, a level smaller than a
// block written as one whole block (WebGPU copies compressed textures in
// whole blocks). The tiles are real fixtures, plus one whose texture block
// is replaced by random legal non-void ASTC blocks, since the archive's own
// textures are swatches of one colour a block. The geometry of each tile,
// the same on every path, is measured once for context.

import { done, fail, fixtureBytes, manifest, publish, stat, type FixtureTile } from "./harness.ts";
import initBench, { legalAstcBlocks } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";
import type { Decoded, Request, Tile, Variant } from "./models-worker.ts";

const query = new URLSearchParams(location.search);
const iterations = Number(query.get("iterations") ?? 50);
const warmup = Number(query.get("warmup") ?? 10);

const FORMATS: Record<Decoded["layout"]["format"], (edge: number) => GPUTextureFormat> = {
  astc: (edge) => `astc-${edge}x${edge}-unorm` as GPUTextureFormat,
  rgba8: () => "rgba8unorm",
  bc7: () => "bc7-rgba-unorm",
};

/** The texture as the main thread would upload it: one write per level and layer. */
function uploadTexture(device: GPUDevice, decoded: Decoded): GPUTexture {
  const { layout, texture: data } = decoded;
  const edge = layout.format === "rgba8" ? 1 : layout.blockEdge;
  const texture = device.createTexture({
    size: [layout.width, layout.height, layout.layerCount],
    format: FORMATS[layout.format](layout.blockEdge),
    mipLevelCount: layout.mipLevelCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  layout.levels.forEach((level, mipLevel) => {
    // The physical size of the level: whole blocks.
    const width = Math.ceil(level.width / edge) * edge;
    const height = Math.ceil(level.height / edge) * edge;
    for (let layer = 0; layer < layout.layerCount; layer++) {
      device.queue.writeTexture(
        { texture, mipLevel, origin: [0, 0, layer] },
        data,
        { offset: level.byteOffset + layer * level.layerByteCount, bytesPerRow: level.bytesPerRow, rowsPerImage: level.rowsPerImage },
        [width, height, 1],
      );
    }
  });
  return texture;
}

/** The vertex and index buffers, written while mapped at creation (decision B3). */
function uploadGeometry(device: GPUDevice, decoded: Decoded): GPUBuffer[] {
  return [
    [decoded.vertices, GPUBufferUsage.VERTEX],
    [new Uint8Array(decoded.indices.buffer), GPUBufferUsage.INDEX],
  ].map(([bytes, usage]) => {
    const source = bytes as Uint8Array;
    const buffer = device.createBuffer({ size: source.byteLength, usage: usage as number, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(source);
    buffer.unmap();
    return buffer;
  });
}

/** A copy of a tile whose texture block holds random legal ASTC blocks. */
function withDenseTexture(tile: Tile): Tile {
  const bytes = tile.bytes.slice();
  const header = new DataView(bytes.buffer);
  const offset = header.getUint32(88, true);
  const length = header.getUint32(92, true);
  const edge = header.getUint32(52, true);
  bytes.set(legalAstcBlocks(length / 16, edge, 14), offset);
  return { ...tile, name: `${tile.name} with random legal ASTC blocks`, bytes };
}

async function run() {
  await initBench();
  const all = (await manifest()) as unknown as { modelTiles?: FixtureTile[] };
  const fixture = async (z: number, x: number, y: number, label: string): Promise<Tile> => {
    const entry = all.modelTiles?.find((t) => t.z === z && t.x === x && t.y === y);
    if (!entry) throw new Error(`no model tile ${z}/${x}/${y} in the fixtures: run \`node scripts/fetch-fixtures.mjs\``);
    return { name: `${z}/${x}/${y} ${label}`, bytes: await fixtureBytes(entry.file), z, x, y };
  };
  const small = await fixture(14, 9904, 5120, "(Moscow, 1 layer)");
  const twoLayers = await fixture(14, 9916, 5126, "(Moscow, 2 layers)");
  const kremlin = await fixture(14, 9904, 5121, "(Kremlin, 2 layers)");
  const tiles = [small, twoLayers, withDenseTexture(twoLayers), kremlin];

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("B14 needs WebGPU");
  const features: GPUFeatureName[] = (["texture-compression-astc", "texture-compression-bc"] as const).filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures: features });
  const runs: Record<Variant, boolean> = {
    astc: device.features.has("texture-compression-astc"),
    rgba8: true,
    bc7: device.features.has("texture-compression-bc"),
  };
  const variants = (Object.keys(runs) as Variant[]).filter((v) => runs[v]);

  const worker = new Worker(new URL("./models-worker.ts", import.meta.url), { type: "module" });
  const ask = (request: Request) =>
    new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (e) => ((e.data as { error?: string }).error ? reject(new Error((e.data as { error: string }).error)) : resolve(e.data));
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage(request);
    });
  await ask({ tiles: tiles.map((t) => ({ ...t, bytes: t.bytes.slice() })) });

  const textureRows: (string | number)[][] = [];
  const geometryRows: (string | number)[][] = [];
  const raw: Record<string, unknown> = { features, variants };
  for (const [index, tile] of tiles.entries()) {
    let last: Decoded | undefined;
    for (const variant of variants) {
      const decode: number[] = [];
      const upload: number[] = [];
      const total: number[] = [];
      const gpuDone: number[] = [];
      for (let i = 0; i < warmup + iterations; i++) {
        const decoded = (await ask({ tile: index, variant })) as Decoded;
        const start = performance.now();
        const texture = uploadTexture(device, decoded);
        const uploaded = performance.now();
        await device.queue.onSubmittedWorkDone();
        const finished = performance.now();
        texture.destroy();
        last = decoded;
        if (i < warmup) continue;
        decode.push(decoded.ms);
        upload.push(uploaded - start);
        total.push(decoded.ms + uploaded - start);
        gpuDone.push(finished - start);
      }
      const [d, u, t, g] = [stat(decode), stat(upload), stat(total), stat(gpuDone)];
      textureRows.push([tile.name, variant, d.median, d.p95, u.median, u.p95, t.median, t.p95, g.median, last!.texture.byteLength]);
      raw[`${tile.name} ${variant}`] = { decode, upload, total, gpuDone, gpuBytes: last!.texture.byteLength, layout: last!.layout };
    }

    const decoded = last!;
    const upload: number[] = [];
    const gpuDone: number[] = [];
    for (let i = 0; i < warmup + iterations; i++) {
      const start = performance.now();
      const buffers = uploadGeometry(device, decoded);
      const uploaded = performance.now();
      await device.queue.onSubmittedWorkDone();
      const finished = performance.now();
      buffers.forEach((b) => b.destroy());
      if (i < warmup) continue;
      upload.push(uploaded - start);
      gpuDone.push(finished - start);
    }
    const [u, g] = [stat(upload), stat(gpuDone)];
    geometryRows.push([tile.name, decoded.vertices.byteLength, decoded.indices.byteLength, u.median, u.p95, g.median]);
    raw[`${tile.name} geometry`] = { upload, gpuDone, vertexBytes: decoded.vertices.byteLength, indexBytes: decoded.indices.byteLength };
  }
  worker.terminate();

  publish(
    `B14: model tile texture paths, ms per tile, ${iterations} iterations after ${warmup} warm-up (variants run: ${variants.join(", ")}; device features: ${features.join(", ") || "none"})`,
    ["tile", "path", "worker decode (median)", "p95", "main upload (median)", "p95", "decode + upload (median)", "p95", "upload to GPU done (median)", "GPU texture bytes"],
    textureRows,
    raw,
  );
  publish(
    "B14: the geometry of the same tiles, for context (the same on every path)",
    ["tile", "vertex bytes", "index bytes", "main upload (median)", "p95", "upload to GPU done (median)"],
    geometryRows,
    {},
  );
  done();
}

run().catch(fail);
