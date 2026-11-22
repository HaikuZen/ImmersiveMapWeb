// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B5, B6 and B7: the CPU cost of encoding a frame's tile draws, at the sizes
// a real frame has (tens to a hundred-odd sources, a few layers each), in
// the ways WebGPU allows:
// - B6: per-draw parameters by a dynamic uniform offset (one setBindGroup per
//   draw), by a storage buffer read at the instance index (firstInstance, no
//   per-draw bind), or by drawIndexedIndirect;
// - B5: every tile in a buffer of its own, or all in one arena buffer with
//   offsets (fewer distinct buffers bound);
// - B7: recording the draws every frame, or replaying a render bundle that
//   is rebuilt only when the set of tiles changes (every `rebuildEvery` frames).

import { done, fail, publish, stat } from "./harness.ts";

const SHADER = /* wgsl */ `
struct Draw { offset: vec2f, scale: f32, pad: f32 }
@group(0) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(0) var<storage, read> draws: array<Draw>;
override kStorage: bool = false;
struct Out { @builtin(position) p: vec4f }
@vertex fn vs(@location(0) p: vec2f, @builtin(instance_index) i: u32) -> Out {
  var d = draw;
  if (kStorage) { d = draws[i]; }
  return Out(vec4f(p * d.scale + d.offset, 0.0, 1.0));
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.6, 0.7, 0.8, 1.0); }`;

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

async function run() {
  const adapter = (await navigator.gpu.requestAdapter())!;
  const timestamps = adapter.features.has("timestamp-query");
  // Without indirect-first-instance WebGPU turns an indirect draw with a
  // non-zero firstInstance into a no-op, and the indirect variant would draw nothing.
  const firstInstance = adapter.features.has("indirect-first-instance");
  const features: GPUFeatureName[] = [];
  if (timestamps) features.push("timestamp-query");
  if (firstInstance) features.push("indirect-first-instance");
  const device = await adapter.requestDevice({ requiredFeatures: features });
  const querySet = timestamps ? device.createQuerySet({ type: "timestamp", count: 2 }) : undefined;
  const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  let gpuSample: number | undefined;
  // Reads the pass's GPU time of the frame just submitted, outside the CPU measurement.
  const readGpu = async () => {
    if (!querySet) return;
    await readback.mapAsync(GPUMapMode.READ);
    const [a, b] = new BigInt64Array(readback.getMappedRange());
    gpuSample = Number(b! - a!) / 1e6;
    readback.unmap();
  };
  const finishTimed = (encoder: GPUCommandEncoder) => {
    if (querySet) {
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
  };
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  document.body.append(canvas);
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const module = device.createShaderModule({ code: SHADER });
  const uniformLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true, minBindingSize: 16 } }] });
  const storageLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, storageLayout] });
  const pipeline = (storage: boolean) =>
    device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs", constants: { kStorage: storage ? 1 : 0 }, buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  const uniformPipeline = pipeline(false);
  const storagePipeline = pipeline(true);

  // A tile: 2,000 triangles in a grid, as one vertex and one index span.
  const tileVertices = new Float32Array(41 * 26 * 2);
  for (let y = 0, k = 0; y < 26; y++) for (let x = 0; x < 41; x++) { tileVertices[k++] = x / 40; tileVertices[k++] = y / 25; }
  const tileIndices: number[] = [];
  for (let y = 0; y < 25; y++) for (let x = 0; x < 40; x++) { const a = y * 41 + x; tileIndices.push(a, a + 1, a + 42, a, a + 42, a + 41); }
  const indexData = new Uint16Array(tileIndices);
  const vBytes = tileVertices.byteLength;
  const iBytes = Math.ceil(indexData.byteLength / 256) * 256;

  const results: { scenario: string; variant: string; s: ReturnType<typeof stat>; gpu: ReturnType<typeof stat> | undefined }[] = [];
  const frames = Number(new URLSearchParams(location.search).get("frames") ?? 120);
  for (const tiles of [40, 160]) {
    const layers = 6; // ground opaque, translucent, lines, roads x2, edge lines
    const drawCount = tiles * layers;
    // B5: separate buffers per tile, or one arena.
    const separate = Array.from({ length: tiles }, () => {
      const v = device.createBuffer({ size: vBytes, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
      new Float32Array(v.getMappedRange()).set(tileVertices);
      v.unmap();
      const i = device.createBuffer({ size: iBytes, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
      new Uint16Array(i.getMappedRange(), 0, indexData.length).set(indexData);
      i.unmap();
      return { v, i };
    });
    const arenaStride = Math.ceil(vBytes / 256) * 256 + iBytes;
    const arena = device.createBuffer({ size: arenaStride * tiles, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX, mappedAtCreation: true });
    for (let t = 0; t < tiles; t++) {
      new Float32Array(arena.getMappedRange(t * arenaStride, vBytes)).set(tileVertices);
      new Uint16Array(arena.getMappedRange(t * arenaStride + Math.ceil(vBytes / 256) * 256, indexData.byteLength)).set(indexData);
    }
    arena.unmap();
    const vOffset = (t: number) => t * arenaStride;
    const iOffset = (t: number) => t * arenaStride + Math.ceil(vBytes / 256) * 256;

    const uniform = device.createBuffer({ size: drawCount * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const storage = device.createBuffer({ size: drawCount * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const indirect = device.createBuffer({ size: drawCount * 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    const uniformStaging = new Float32Array(drawCount * 64);
    const storageStaging = new Float32Array(drawCount * 4);
    const indirectStaging = new Uint32Array(drawCount * 5);
    const cols = Math.ceil(Math.sqrt(tiles));
    for (let d = 0; d < drawCount; d++) {
      const t = Math.floor(d / layers);
      const ox = -1 + (t % cols) * (2 / cols), oy = -1 + Math.floor(t / cols) * (2 / cols), s = 2 / cols;
      uniformStaging.set([ox, oy, s * 0.95, 0], d * 64);
      storageStaging.set([ox, oy, s * 0.95, 0], d * 4);
      indirectStaging.set([indexData.length / layers, 1, (d % layers) * (indexData.length / layers), 0, d], d * 5);
    }
    const uniformGroup = device.createBindGroup({ layout: uniformLayout, entries: [{ binding: 0, resource: { buffer: uniform, size: 16 } }] });
    const storageGroup = device.createBindGroup({ layout: storageLayout, entries: [{ binding: 0, resource: { buffer: storage } }] });
    const dummyStorage = storageGroup;
    const zeroUniform = uniformGroup;

    type Encoder = GPURenderPassEncoder | GPURenderBundleEncoder;
    const encodeDraws = (pass: Encoder, mode: "uniform" | "storage" | "indirect", buffers: "separate" | "arena") => {
      pass.setPipeline(mode === "uniform" ? uniformPipeline : storagePipeline);
      if (mode !== "uniform") {
        pass.setBindGroup(0, zeroUniform, [0]);
        pass.setBindGroup(1, storageGroup);
      } else {
        pass.setBindGroup(1, dummyStorage);
      }
      const per = indexData.length / layers;
      for (let t = 0; t < tiles; t++) {
        if (buffers === "separate") {
          pass.setVertexBuffer(0, separate[t]!.v);
          pass.setIndexBuffer(separate[t]!.i, "uint16");
        } else {
          pass.setVertexBuffer(0, arena, vOffset(t), vBytes);
          pass.setIndexBuffer(arena, "uint16", iOffset(t), indexData.byteLength);
        }
        for (let l = 0; l < layers; l++) {
          const d = t * layers + l;
          if (mode === "uniform") {
            pass.setBindGroup(0, uniformGroup, [d * 256]);
            pass.drawIndexed(per, 1, l * per);
          } else if (mode === "storage") {
            pass.drawIndexed(per, 1, l * per, 0, d);
          } else {
            pass.drawIndexedIndirect(indirect, d * 20);
          }
        }
      }
    };
    const begin = (encoder: GPUCommandEncoder) =>
      encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }], ...(querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}) });

    const variants: [string, (frame: number) => void][] = [];
    for (const buffers of ["separate", "arena"] as const) {
      for (const mode of firstInstance ? (["uniform", "storage", "indirect"] as const) : (["uniform", "storage"] as const)) {
        variants.push([`direct, ${mode}, ${buffers} buffers`, () => {
          // The per-frame upload of the draws' parameters is part of the cost.
          if (mode === "uniform") device.queue.writeBuffer(uniform, 0, uniformStaging);
          else if (mode === "storage") device.queue.writeBuffer(storage, 0, storageStaging);
          else { device.queue.writeBuffer(storage, 0, storageStaging); device.queue.writeBuffer(indirect, 0, indirectStaging); }
          const encoder = device.createCommandEncoder();
          const pass = begin(encoder);
          encodeDraws(pass, mode, buffers);
          pass.end();
          finishTimed(encoder);
        }]);
      }
    }
    for (const rebuildEvery of [1, 10, 60]) {
      let bundle: GPURenderBundle | undefined;
      variants.push([`bundle rebuilt every ${rebuildEvery} frames, storage, arena`, (frame) => {
        device.queue.writeBuffer(storage, 0, storageStaging);
        if (!bundle || frame % rebuildEvery === 0) {
          const be = device.createRenderBundleEncoder({ colorFormats: [format] });
          encodeDraws(be, "storage", "arena");
          bundle = be.finish();
        }
        const encoder = device.createCommandEncoder();
        const pass = begin(encoder);
        pass.executeBundles([bundle]);
        pass.end();
        finishTimed(encoder);
      }]);
    }
    for (const [variant, frame] of variants) {
      const times: number[] = [];
      const gpuTimes: number[] = [];
      for (let f = 0; f < frames + 10; f++) {
        await nextFrame();
        const start = performance.now();
        frame(f);
        const elapsed = performance.now() - start;
        await readGpu();
        if (f >= 10) {
          times.push(elapsed);
          if (gpuSample !== undefined) gpuTimes.push(gpuSample);
        }
      }
      results.push({ scenario: `${tiles} tiles x ${layers} layers (${drawCount} draws)`, variant, s: stat(times), gpu: gpuTimes.length ? stat(gpuTimes) : undefined });
    }
    for (const b of separate) { b.v.destroy(); b.i.destroy(); }
    arena.destroy();
  }
  publish("B5/B6/B7: CPU ms to upload the draw parameters, record and submit a frame", ["scenario", "variant", "CPU median ms", "CPU p95 ms", "GPU median ms"], results.map((r) => [r.scenario, r.variant, r.s.median, r.s.p95, r.gpu?.median ?? "n/a"]), results);
  done();
}

run().catch(fail);
