// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The TypeScript half of the draw-call benchmark, beside the Rust half in
// crates/bench-wgpu. Both draw the same grid of quads the same way.

import initWgpu, { WgpuBench } from "../../../packages/immersive-map/src/wasm/bench_wgpu/bench_wgpu.js";

const DRAW_COUNTS = [500, 2_000, 5_000, 10_000, 20_000];
const CAPACITY = 20_000;
const FRAMES = 90;
const WARMUP = 15;
const STRIDE = 256;

const SHADER = /* wgsl */ `
struct Quad { offset: vec2f, size: vec2f, color: vec4f }
@group(0) @binding(0) var<uniform> quad: Quad;
struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let corner = vec2f(f32(i & 1u), f32((i >> 1u) & 1u));
  var out: Out;
  out.position = vec4f(quad.offset + corner * quad.size, 0.0, 1.0);
  out.color = quad.color;
  return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f { return input.color; }`;

function quadUniforms(count: number): Float32Array<ArrayBuffer> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const cell = 2 / columns;
  const data = new Float32Array((count * STRIDE) / 4);
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count);
    data.set([-1 + (i % columns) * cell, -1 + Math.floor(i / columns) * cell, cell * 0.8, cell * 0.8, 0.3 + 0.7 * t, 0.5, 1 - 0.7 * t, 1], (i * STRIDE) / 4);
  }
  return data;
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function measure(frame: () => void): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < FRAMES + WARMUP; i++) {
    await nextFrame();
    const start = performance.now();
    frame();
    const elapsed = performance.now() - start;
    if (i >= WARMUP) times.push(elapsed);
  }
  return median(times);
}

async function typescriptBench() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const device = await adapter!.requestDevice();
  const canvas = document.getElementById("ts") as HTMLCanvasElement;
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true, minBindingSize: 32 } }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-strip" },
  });
  const buffer = device.createBuffer({ size: CAPACITY * STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, quadUniforms(CAPACITY));
  const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer, size: 32 } }] });
  const clearValue = { r: 0.08, g: 0.08, b: 0.1, a: 1 };

  const frame = (draws: number) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    for (let i = 0; i < draws; i++) {
      pass.setBindGroup(0, bindGroup, [i * STRIDE]);
      pass.draw(4);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  const bundleFor = (draws: number) => {
    const encoder = device.createRenderBundleEncoder({ colorFormats: [format] });
    encoder.setPipeline(pipeline);
    for (let i = 0; i < draws; i++) {
      encoder.setBindGroup(0, bindGroup, [i * STRIDE]);
      encoder.draw(4);
    }
    return encoder.finish();
  };
  const bundleFrame = (bundle: GPURenderBundle) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue, loadOp: "clear", storeOp: "store" }],
    });
    pass.executeBundles([bundle]);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  return { frame, bundleFor, bundleFrame };
}

async function run() {
  const status = document.getElementById("status")!;
  const table = document.getElementById("results") as HTMLTableElement;
  const ts = await typescriptBench();
  await initWgpu();
  const wgpu = await WgpuBench.create(document.getElementById("wgpu") as HTMLCanvasElement, CAPACITY);
  const results: { draws: number; typescript: number; bundle: number; wgpu: number }[] = [];
  for (const draws of DRAW_COUNTS) {
    status.textContent = `measuring ${draws} draws…`;
    const typescript = await measure(() => ts.frame(draws));
    const bundle = ts.bundleFor(draws);
    const bundled = await measure(() => ts.bundleFrame(bundle));
    const rust = await measure(() => wgpu.frame(draws));
    results.push({ draws, typescript, bundle: bundled, wgpu: rust });
    const row = table.insertRow();
    for (const value of [draws.toLocaleString(), typescript.toFixed(3), bundled.toFixed(3), rust.toFixed(3)]) row.insertCell().textContent = value;
  }
  status.textContent = "done";
  Object.assign(window, { benchResults: results });
}

run().catch((error) => {
  document.getElementById("status")!.textContent = `failed: ${String(error)}`;
  Object.assign(window, { benchError: String(error) });
});
