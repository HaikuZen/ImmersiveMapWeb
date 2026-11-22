// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B8: the frame both variants draw, the size of the map's: 160 tiles of 2,000
// triangles in six layers (960 draws, parameters in a storage array read at
// the instance index, decision B6), offset by the camera the main thread sends.

const SHADER = /* wgsl */ `
struct Draw { offset: vec2f, scale: f32, pad: f32 }
@group(0) @binding(0) var<storage, read> draws: array<Draw>;
struct Out { @builtin(position) p: vec4f }
@vertex fn vs(@location(0) p: vec2f, @builtin(instance_index) i: u32) -> Out {
  let d = draws[i];
  return Out(vec4f(p * d.scale + d.offset, 0.0, 1.0));
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.6, 0.7, 0.8, 1.0); }`;

export interface Scene {
  draw(camera: number): void;
}

export async function createScene(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Scene> {
  const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
  });
  const vertices = new Float32Array(41 * 26 * 2);
  for (let y = 0, k = 0; y < 26; y++) for (let x = 0; x < 41; x++) { vertices[k++] = x / 40; vertices[k++] = y / 25; }
  const indices: number[] = [];
  for (let y = 0; y < 25; y++) for (let x = 0; x < 40; x++) { const a = y * 41 + x; indices.push(a, a + 1, a + 42, a, a + 42, a + 41); }
  const vb = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vb, 0, vertices);
  const indexData = new Uint16Array(indices);
  const ib = device.createBuffer({ size: Math.ceil(indexData.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ib, 0, indexData.buffer, 0, Math.ceil(indexData.byteLength / 4) * 4);
  const tiles = 160, layers = 6, draws = tiles * layers;
  const storage = device.createBuffer({ size: draws * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  const staging = new Float32Array(draws * 4);
  const cols = Math.ceil(Math.sqrt(tiles));
  const per = indexData.length / layers;
  return {
    draw(camera: number) {
      const shift = Math.sin(camera * 0.05) * 0.2;
      for (let d = 0; d < draws; d++) {
        const t = Math.floor(d / layers);
        staging[d * 4] = -1 + (t % cols) * (2 / cols) + shift;
        staging[d * 4 + 1] = -1 + Math.floor(t / cols) * (2 / cols);
        staging[d * 4 + 2] = (2 / cols) * 0.95;
      }
      device.queue.writeBuffer(storage, 0, staging);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, vb);
      pass.setIndexBuffer(ib, "uint16");
      for (let d = 0; d < draws; d++) pass.drawIndexed(per, 1, (d % layers) * per, 0, d);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
  };
}
