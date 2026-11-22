// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B13: each delivery format of the MTSDF atlas, from its bytes to a GPU
// texture the text shader can sample, timed on the main thread up to the
// GPU's completion, and read back to check every byte against the raw atlas
// (an alpha premultiply or a colour conversion would ruin a distance field).

import { done, fail, publish, stat } from "./harness.ts";

const SIZE = 2048;
type Path = (bytes: ArrayBuffer, device: GPUDevice) => Promise<GPUTexture>;

function texture(device: GPUDevice): GPUTexture {
  return device.createTexture({
    size: [SIZE, SIZE],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

const raw: Path = async (bytes, device) => {
  const t = texture(device);
  device.queue.writeTexture({ texture: t }, bytes, { bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
  return t;
};

const gzip: Path = async (bytes, device) => {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
  void writer.close();
  return raw(await new Response(stream.readable).arrayBuffer(), device);
};

const bitmap =
  (type: string): Path =>
  async (bytes, device) => {
    const image = await createImageBitmap(new Blob([bytes], { type }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const t = texture(device);
    device.queue.copyExternalImageToTexture({ source: image }, { texture: t, premultipliedAlpha: false }, [SIZE, SIZE]);
    image.close();
    return t;
  };

const decoder =
  (type: string): Path =>
  async (bytes, device) => {
    // ImageDecoderInit has no premultiplyAlpha: the benchmark shows what that costs a distance field.
    const d = new ImageDecoder({ data: bytes, type, colorSpaceConversion: "none" });
    const { image } = await d.decode();
    const t = texture(device);
    device.queue.copyExternalImageToTexture({ source: image }, { texture: t, premultipliedAlpha: false }, [SIZE, SIZE]);
    image.close();
    d.close();
    return t;
  };

async function readBack(device: GPUDevice, t: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({ size: SIZE * SIZE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const copy = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.destroy();
  return copy;
}

async function run() {
  const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
  const iterations = Number(new URLSearchParams(location.search).get("iterations") ?? 15);
  const rows: (string | number)[][] = [];
  const raws: Record<string, unknown> = {};
  for (const name of ["atlas", "atlas_thin"]) {
    const reference = new Uint8Array(await (await fetch(`/fixtures/atlas/${name}.rgba`)).arrayBuffer());
    const formats: [string, string, Path][] = [
      ["raw RGBA", `${name}.rgba`, raw],
      ["raw RGBA, gzip + DecompressionStream", `${name}.rgba.gz`, gzip],
      ["PNG, createImageBitmap", `${name}.png`, bitmap("image/png")],
      ["PNG, ImageDecoder", `${name}.png`, decoder("image/png")],
      ["WebP lossless, createImageBitmap", `${name}.webp`, bitmap("image/webp")],
      ["WebP lossless, ImageDecoder", `${name}.webp`, decoder("image/webp")],
    ];
    for (const [label, file, path] of formats) {
      const bytes = await (await fetch(`/fixtures/atlas/${file}`)).arrayBuffer();
      // Correctness first: every byte as in the raw atlas.
      const checked = await path(bytes.slice(0), device);
      const back = await readBack(device, checked);
      checked.destroy();
      let mismatched = 0;
      for (let i = 0; i < back.length; i++) if (back[i] !== reference[i]) mismatched++;
      const times: number[] = [];
      for (let i = 0; i < iterations + 2; i++) {
        const copy = bytes.slice(0);
        const start = performance.now();
        const t = await path(copy, device);
        await device.queue.onSubmittedWorkDone();
        if (i >= 2) times.push(performance.now() - start);
        t.destroy();
      }
      const s = stat(times);
      raws[`${name} ${label}`] = times;
      rows.push([`${name}: ${label}`, bytes.byteLength / 1024, s.median, s.p95, mismatched]);
    }
  }
  publish("B13: bytes shipped and ms from bytes to a sampled texture (main thread, to GPU completion)", ["format", "KiB", "median ms", "p95 ms", "bytes differing from raw"], rows, raws);
  done();
}

run().catch(fail);
