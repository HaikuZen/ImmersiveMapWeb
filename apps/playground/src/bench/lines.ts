// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B18: drawing a tile's lines as one quad instance per segment (the segment's
// two ends in the instance, the quad extruded in the vertex shader, as the
// Swift engine's instanced line layers do) against the ribbons the parser
// triangulates (four 16-byte vertices and six indices per segment, the
// arena's tile vertex). The same polylines, the same width and the same
// analytic edge in both, so the GPU time and the bytes compare the layouts.

import { done, fail, publish, stat } from "./harness.ts";

const COMMON = /* wgsl */ `
struct Frame { scale: vec2f, halfWidth: f32, pad: f32 }
@group(0) @binding(0) var<uniform> frame: Frame;
struct Out { @builtin(position) p: vec4f, @location(0) across: f32 }
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let a = 1.0 - smoothstep(0.7, 1.0, abs(in.across));
  return vec4f(0.9, 0.8, 0.5, 1.0) * a;
}`;

const INSTANCED = COMMON + /* wgsl */ `
@vertex fn vs(@location(0) a: vec2f, @location(1) b: vec2f, @builtin(vertex_index) v: u32) -> Out {
  let along = b - a;
  let n = normalize(vec2f(-along.y, along.x));
  let end = select(a, b, (v & 1u) == 1u);
  let side = select(-1.0, 1.0, (v & 2u) == 2u);
  let p = end + n * side * frame.halfWidth;
  return Out(vec4f(p * frame.scale - 1.0, 0.0, 1.0), side);
}`;

const RIBBON = COMMON + /* wgsl */ `
@vertex fn vs(@location(0) p: vec2f, @location(1) style: u32, @location(2) distance: i32, @location(3) param: i32, @location(4) normal: vec2f) -> Out {
  let across = f32(distance) / 127.0;
  let q = p + normal * across * frame.halfWidth;
  return Out(vec4f(q * frame.scale - 1.0, 0.0, 1.0), across);
}`;

async function run() {
  const adapter = (await navigator.gpu.requestAdapter())!;
  if (!adapter.features.has("timestamp-query")) throw new Error("B18 needs timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1000;
  document.body.append(canvas);
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const frameBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
  const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: frameBuffer } }] });
  const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
  const pipeline = (code: string, buffers: GPUVertexBufferLayout[], topology: GPUPrimitiveTopology) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: device.createShaderModule({ code }), entryPoint: "vs", buffers },
      fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology },
    });
  const instanced = pipeline(INSTANCED, [{ arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }] }], "triangle-strip");
  const ribbon = pipeline(
    RIBBON,
    [{ arrayStride: 16, attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "uint8" },
      { shaderLocation: 2, offset: 9, format: "sint8" },
      { shaderLocation: 3, offset: 10, format: "sint16" },
      { shaderLocation: 4, offset: 12, format: "snorm8x2" },
    ] }],
    "triangle-list",
  );

  const rows: (string | number)[][] = [];
  const raw: unknown[] = [];
  const frames = Number(new URLSearchParams(location.search).get("frames") ?? 120);
  for (const [segments, halfWidth] of [[50_000, 1.5], [200_000, 1.5], [200_000, 6]] as const) {
    // Random polylines of 20 segments over the tile, in tile units (0 to 4096).
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const points: [number, number][][] = [];
    for (let made = 0; made < segments; made += 20) {
      let x = rand() * 4096, y = rand() * 4096, heading = rand() * Math.PI * 2;
      const line: [number, number][] = [[x, y]];
      for (let s = 0; s < 20; s++) {
        heading += (rand() - 0.5) * 0.8;
        x += Math.cos(heading) * 30;
        y += Math.sin(heading) * 30;
        line.push([x, y]);
      }
      points.push(line);
    }
    const instances = new Float32Array(segments * 4);
    const vertices = new ArrayBuffer(segments * 4 * 16);
    const vf = new Float32Array(vertices);
    const vb = new DataView(vertices);
    const indices = new Uint32Array(segments * 6);
    let k = 0;
    for (const line of points) {
      for (let s = 0; s < line.length - 1 && k < segments; s++, k++) {
        const [ax, ay] = line[s]!;
        const [bx, by] = line[s + 1]!;
        instances.set([ax, ay, bx, by], k * 4);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = -(by - ay) / len, ny = (bx - ax) / len;
        const corners: [number, number, number][] = [[ax, ay, -1], [bx, by, -1], [ax, ay, 1], [bx, by, 1]];
        corners.forEach(([px, py, side], c) => {
          const base = (k * 4 + c) * 16;
          vf[base / 4] = px;
          vf[base / 4 + 1] = py;
          vb.setUint8(base + 8, 0);
          vb.setInt8(base + 9, side * 127);
          vb.setInt16(base + 10, 0, true);
          vb.setInt8(base + 12, Math.round(nx * 127));
          vb.setInt8(base + 13, Math.round(ny * 127));
        });
        const v = k * 4;
        indices.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], k * 6);
      }
    }
    const upload = (data: ArrayBufferView | ArrayBuffer, usage: number) => {
      const bytes = data instanceof ArrayBuffer ? data : data.buffer;
      const buffer = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes));
      buffer.unmap();
      return buffer;
    };
    const instanceBuffer = upload(instances, GPUBufferUsage.VERTEX);
    const vertexBuffer = upload(vertices, GPUBufferUsage.VERTEX);
    const indexBuffer = upload(indices, GPUBufferUsage.INDEX);
    device.queue.writeBuffer(frameBuffer, 0, new Float32Array([2 / 4096, 2 / 4096, halfWidth, 0]));
    const variants: [string, number, (pass: GPURenderPassEncoder) => void][] = [
      ["instance per segment", instances.byteLength, (pass) => { pass.setPipeline(instanced); pass.setVertexBuffer(0, instanceBuffer); pass.draw(4, segments); }],
      ["triangulated ribbon", vertices.byteLength + indices.byteLength, (pass) => { pass.setPipeline(ribbon); pass.setVertexBuffer(0, vertexBuffer); pass.setIndexBuffer(indexBuffer, "uint32"); pass.drawIndexed(segments * 6); }],
    ];
    for (const [name, bytes, draw] of variants) {
      const gpu: number[] = [];
      for (let f = 0; f < frames + 10; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
          timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
        });
        pass.setBindGroup(0, group);
        draw(pass);
        pass.end();
        encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const [a, b] = new BigInt64Array(readback.getMappedRange());
        readback.unmap();
        if (f >= 10) gpu.push(Number(b! - a!) / 1e6);
      }
      const s = stat(gpu);
      rows.push([`${segments} segments, half width ${halfWidth}`, name, s.median, s.p95, (bytes / 1e6).toFixed(2)]);
      raw.push({ segments, halfWidth, variant: name, gpu: s, bytes });
    }
    instanceBuffer.destroy();
    vertexBuffer.destroy();
    indexBuffer.destroy();
  }
  publish("B18: GPU ms per frame and buffer MB", ["scenario", "variant", "GPU median ms", "GPU p95 ms", "buffer MB"], rows, raw);
  done();
}

run().catch(fail);
