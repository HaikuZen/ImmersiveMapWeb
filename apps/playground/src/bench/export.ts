// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B20: the path from a rendered WebGPU frame to a WebCodecs VideoEncoder, and
// from one frame to a PNG Blob. Every path renders the same scene (a
// fullscreen fragment shader with a 40-step ALU loop plus 4,000 instanced
// triangles, animated per frame so no two frames are equal).
// Video paths, each measured end to end (render, VideoFrame, encode, close,
// backpressure on encodeQueueSize, final flush):
//   A: a WebGPU canvas context on an HTMLCanvasElement outside the document,
//      handed over as new VideoFrame(canvas) in the same task as the submit.
//   C: the same on an OffscreenCanvas.
//   B: a texture copied into MAP_READ buffers, mapAsync, then a VideoFrame
//      from the bytes, with one staging buffer and with three in flight.
// Still paths, one 1920x1080 frame to a PNG Blob:
//   S1: canvas.toBlob right after the submit.
//   S2: createImageBitmap(canvas), drawImage on an OffscreenCanvas 2D, convertToBlob.
//   S3: readback to bytes, putImageData on an OffscreenCanvas 2D, convertToBlob.
// Each path is also checked against a readback of the same frame, so a path
// that hands over a blank or stale frame shows up.

import { done, fail, publish, stat, type Stat } from "./harness.ts";

const params = new URLSearchParams(location.search);
const FRAMES = Number(params.get("frames") ?? 120);
const WARMUP = Number(params.get("warmup") ?? 30);
const STILLS = Number(params.get("stills") ?? 50);
const SIZES = (params.get("sizes") ?? "1920x1080,3840x2160").split(",").map((s) => s.split("x").map(Number) as [number, number]);
const FRAME_US = 33_333;

const SHADER = /* wgsl */ `
struct U { time: f32, aspect: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var<uniform> u: U;

struct FullOut { @builtin(position) p: vec4f, @location(0) uv: vec2f }
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> FullOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return FullOut(vec4f(p, 0.0, 1.0), p * 0.5 + 0.5);
}
@fragment fn fsFull(v: FullOut) -> @location(0) vec4f {
  var z = (v.uv - 0.5) * vec2f(u.aspect, 1.0) * 2.5;
  var c = vec3f(0.0);
  for (var k = 0; k < 40; k++) {
    z = vec2f(sin(z.y * 1.7 + u.time), cos(z.x * 1.3 - u.time * 0.7)) + z * 0.6;
    c += abs(vec3f(z.x, z.y, z.x * z.y)) * 0.02;
  }
  return vec4f(fract(c + u.time * 0.05), 1.0);
}

struct TriOut { @builtin(position) p: vec4f, @location(0) color: vec3f }
@vertex fn vsTri(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> TriOut {
  let fi = f32(i);
  let h = fract(sin(vec2f(fi * 12.9898, fi * 78.233)) * 43758.5453);
  let center = h * 2.0 - 1.0 + vec2f(sin(u.time + fi), cos(u.time * 1.3 + fi)) * 0.05;
  let a = f32(v) * 2.0943951 + u.time + fi;
  let r = 0.02 + 0.02 * h.x;
  let p = center + vec2f(cos(a) / u.aspect, sin(a)) * r;
  return TriOut(vec4f(p, 0.0, 1.0), vec3f(h, fract(fi * 0.618)));
}
@fragment fn fsTri(v: TriOut) -> @location(0) vec4f { return vec4f(v.color, 1.0); }`;

const INSTANCES = 4000;

interface Scene {
  /** Records frame f into the view and leaves submitting to the caller. */
  record(encoder: GPUCommandEncoder, view: GPUTextureView, format: GPUTextureFormat, f: number, aspect: number): void;
}

function createScene(device: GPUDevice): Scene {
  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }] });
  const pipelines = new Map<GPUTextureFormat, [GPURenderPipeline, GPURenderPipeline]>();
  const pipelinesFor = (format: GPUTextureFormat) => {
    let pair = pipelines.get(format);
    if (!pair) {
      const make = (vs: string, fs: string) =>
        device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module, entryPoint: vs },
          fragment: { module, entryPoint: fs, targets: [{ format }] },
        });
      pair = [make("vsFull", "fsFull"), make("vsTri", "fsTri")];
      pipelines.set(format, pair);
    }
    return pair;
  };
  const data = new Float32Array(4);
  return {
    record(encoder, view, format, f, aspect) {
      data[0] = f * 0.37;
      data[1] = aspect;
      device.queue.writeBuffer(uniforms, 0, data);
      const [full, tri] = pipelinesFor(format);
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setBindGroup(0, group);
      pass.setPipeline(full);
      pass.draw(3);
      pass.setPipeline(tri);
      pass.draw(3, INSTANCES);
      pass.end();
    },
  };
}

const alignedRow = (width: number) => Math.ceil((width * 4) / 256) * 256;

/** A render target plus staging buffers for the readback paths. */
function createReadback(device: GPUDevice, width: number, height: number, format: GPUTextureFormat, depth: number) {
  const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const view = texture.createView();
  const bytesPerRow = alignedRow(width);
  const buffers = Array.from({ length: depth }, () => device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  return {
    texture,
    view,
    bytesPerRow,
    buffers,
    copy(encoder: GPUCommandEncoder, slot: number) {
      encoder.copyTextureToBuffer({ texture }, { buffer: buffers[slot]!, bytesPerRow, rowsPerImage: height }, [width, height]);
    },
    destroy() {
      texture.destroy();
      for (const b of buffers) b.destroy();
    },
  };
}

/** Tight RGBA pixels of frame f rendered into a texture and read back: the reference for the checks. */
async function referencePixels(device: GPUDevice, scene: Scene, width: number, height: number, f: number): Promise<Uint8ClampedArray> {
  const rb = createReadback(device, width, height, "rgba8unorm", 1);
  const encoder = device.createCommandEncoder();
  scene.record(encoder, rb.view, "rgba8unorm", f, width / height);
  rb.copy(encoder, 0);
  device.queue.submit([encoder.finish()]);
  await rb.buffers[0]!.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(rb.buffers[0]!.getMappedRange());
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) out.set(mapped.subarray(y * rb.bytesPerRow, y * rb.bytesPerRow + width * 4), y * width * 4);
  rb.buffers[0]!.unmap();
  rb.destroy();
  return out;
}

let probe: OffscreenCanvasRenderingContext2D | null = null;
/** RGBA pixels of any image source, drawn into a 2D canvas. */
function pixelsOf(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  if (!probe || probe.canvas.width !== width || probe.canvas.height !== height) {
    probe = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true })!;
  }
  probe.clearRect(0, 0, width, height);
  probe.drawImage(source, 0, 0);
  return probe.getImageData(0, 0, width, height).data;
}

/** Mean absolute difference per channel over a sparse grid of RGB samples. */
function meanDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4 * 97) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c]! - b[i + c]!);
    n += 3;
  }
  return sum / n;
}

type PathName = "A canvas" | "C OffscreenCanvas" | "B readback x1" | "B readback x3";
const PATHS: PathName[] = ["A canvas", "C OffscreenCanvas", "B readback x1", "B readback x3"];

interface CanvasTarget {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: GPUCanvasContext;
}

function canvasTarget(device: GPUDevice, width: number, height: number, offscreen: boolean): CanvasTarget {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (offscreen) canvas = new OffscreenCanvas(width, height);
  else {
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    canvas = element;
  }
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "premultiplied" });
  return { canvas, context };
}

/**
 * A frame source for one path: produce(count, onFrame) renders frames
 * [base, base + count) and hands each VideoFrame to onFrame in order. It adds
 * the main thread's synchronous time of each frame to busy.
 */
interface Source {
  produce(base: number, count: number, before: () => Promise<void>, onFrame: (frame: VideoFrame, i: number) => void, busy: number[]): Promise<void>;
  /** One VideoFrame of frame f, for the correctness check. */
  single(f: number): Promise<VideoFrame>;
  destroy(): void;
}

function makeSource(device: GPUDevice, scene: Scene, path: PathName, width: number, height: number): Source {
  const format = navigator.gpu.getPreferredCanvasFormat();
  const aspect = width / height;
  if (path === "A canvas" || path === "C OffscreenCanvas") {
    const target = canvasTarget(device, width, height, path === "C OffscreenCanvas");
    const one = (f: number) => {
      const encoder = device.createCommandEncoder();
      scene.record(encoder, target.context.getCurrentTexture().createView(), format, f, aspect);
      device.queue.submit([encoder.finish()]);
      return new VideoFrame(target.canvas, { timestamp: f * FRAME_US, duration: FRAME_US });
    };
    return {
      async produce(base, count, before, onFrame, busy) {
        for (let i = 0; i < count; i++) {
          await before();
          const t0 = performance.now();
          onFrame(one(base + i), i);
          busy[i]! += performance.now() - t0;
        }
      },
      async single(f) {
        return one(f);
      },
      destroy() {
        target.context.unconfigure();
      },
    };
  }
  const depth = path === "B readback x3" ? 3 : 1;
  const rb = createReadback(device, width, height, format, depth);
  const pixelFormat: VideoPixelFormat = format === "bgra8unorm" ? "BGRA" : "RGBA";
  const submit = (f: number, slot: number) => {
    const encoder = device.createCommandEncoder();
    scene.record(encoder, rb.view, format, f, aspect);
    rb.copy(encoder, slot);
    device.queue.submit([encoder.finish()]);
    return rb.buffers[slot]!.mapAsync(GPUMapMode.READ);
  };
  const toFrame = (f: number, slot: number) => {
    const buffer = rb.buffers[slot]!;
    const frame = new VideoFrame(new Uint8Array(buffer.getMappedRange()), {
      format: pixelFormat,
      codedWidth: width,
      codedHeight: height,
      timestamp: f * FRAME_US,
      duration: FRAME_US,
      layout: [{ offset: 0, stride: rb.bytesPerRow }],
    });
    buffer.unmap();
    return frame;
  };
  return {
    async produce(base, count, before, onFrame, busy) {
      const maps: Promise<void>[] = [];
      for (let i = 0; i < count + depth - 1; i++) {
        if (i < count) {
          const t0 = performance.now();
          maps[i % depth] = submit(base + i, i % depth);
          busy[i]! += performance.now() - t0;
        }
        const j = i - (depth - 1);
        if (j < 0 || j >= count) continue;
        await maps[j % depth];
        await before();
        const t1 = performance.now();
        onFrame(toFrame(base + j, j % depth), j);
        busy[j]! += performance.now() - t1;
      }
    },
    async single(f) {
      await submit(f, 0);
      return toFrame(f, 0);
    },
    destroy() {
      rb.destroy();
    },
  };
}

interface Codec {
  name: string;
  config: (width: number, height: number) => VideoEncoderConfig;
}

const CODECS: Codec[] = [
  { name: "H.264", config: (width, height) => ({ codec: "avc1.640034", avc: { format: "avc" }, width, height }) },
  { name: "HEVC", config: (width, height) => ({ codec: "hvc1.1.6.L153.B0", width, height }) },
  { name: "AV1", config: (width, height) => ({ codec: "av01.0.12M.08", width, height }) },
];

function fullConfig(codec: Codec, width: number, height: number, acceleration: HardwareAcceleration): VideoEncoderConfig {
  return { ...codec.config(width, height), bitrate: Math.round(width * height * 30 * 0.1), framerate: 30, hardwareAcceleration: acceleration };
}

interface VideoRun {
  fps: number;
  wallMs: number;
  main: Stat;
  chunks: number;
  bytes: number;
  busy: number[];
}

async function runVideo(source: Source, config: VideoEncoderConfig): Promise<VideoRun> {
  let chunks = 0;
  let bytes = 0;
  let error: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      chunks++;
      bytes += chunk.byteLength;
    },
    error: (e) => (error = e),
  });
  encoder.configure(config);
  const dequeued = () => new Promise<void>((r) => encoder.addEventListener("dequeue", () => r(), { once: true }));
  const before = async () => {
    while (encoder.encodeQueueSize > 2) await dequeued();
  };
  const onFrame = (frame: VideoFrame, i: number) => {
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
  };
  await source.produce(0, WARMUP, before, onFrame, new Array(WARMUP).fill(0));
  await encoder.flush();
  chunks = 0;
  bytes = 0;
  const busy = new Array<number>(FRAMES).fill(0);
  const start = performance.now();
  await source.produce(WARMUP, FRAMES, before, onFrame, busy);
  await encoder.flush();
  const wallMs = performance.now() - start;
  encoder.close();
  if (error) throw error;
  return { fps: (FRAMES * 1000) / wallMs, wallMs, main: stat(busy), chunks, bytes, busy };
}

async function stills(device: GPUDevice, scene: Scene) {
  const width = 1920;
  const height = 1080;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const target = canvasTarget(device, width, height, false);
  const canvas = target.canvas as HTMLCanvasElement;
  const draw2d = new OffscreenCanvas(width, height).getContext("2d")!;
  const rb = createReadback(device, width, height, "rgba8unorm", 1);
  const renderCanvas = (f: number) => {
    const encoder = device.createCommandEncoder();
    scene.record(encoder, target.context.getCurrentTexture().createView(), format, f, width / height);
    device.queue.submit([encoder.finish()]);
  };
  const s1 = (f: number) => {
    renderCanvas(f);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob gave null"))), "image/png"));
  };
  const s2 = async (f: number) => {
    renderCanvas(f);
    const bitmap = await createImageBitmap(canvas);
    draw2d.drawImage(bitmap, 0, 0);
    bitmap.close();
    return draw2d.canvas.convertToBlob({ type: "image/png" });
  };
  const s3 = async (f: number) => {
    const encoder = device.createCommandEncoder();
    scene.record(encoder, rb.view, "rgba8unorm", f, width / height);
    rb.copy(encoder, 0);
    device.queue.submit([encoder.finish()]);
    const buffer = rb.buffers[0]!;
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    if (rb.bytesPerRow === width * 4) pixels.set(mapped);
    else for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * rb.bytesPerRow, y * rb.bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    draw2d.putImageData(new ImageData(pixels, width, height), 0, 0);
    return draw2d.canvas.convertToBlob({ type: "image/png" });
  };
  const variants: [string, (f: number) => Promise<Blob>][] = [
    ["S1 canvas.toBlob", s1],
    ["S2 createImageBitmap + OffscreenCanvas 2D", s2],
    ["S3 readback + ImageData + OffscreenCanvas 2D", s3],
  ];
  const rows: (string | number)[][] = [];
  const checks: (string | number)[][] = [];
  const raw: Record<string, unknown> = {};
  let f = 10_000;
  for (const [name, run] of variants) {
    for (let i = 0; i < 5; i++) await run(f++);
    const samples: number[] = [];
    let size = 0;
    for (let i = 0; i < STILLS; i++) {
      const t0 = performance.now();
      const blob = await run(f++);
      samples.push(performance.now() - t0);
      size = blob.size;
    }
    const s = stat(samples);
    rows.push([name, s.median, s.p95, s.n, size / 1024]);
    raw[name] = samples;
    // The check: decode the PNG of frame f and compare it with the reference of f and of f - 1.
    const checkFrame = f++;
    const blob = await run(checkFrame);
    const bitmap = await createImageBitmap(blob);
    const got = pixelsOf(bitmap, width, height);
    bitmap.close();
    const now = await referencePixels(device, scene, width, height, checkFrame);
    const prev = await referencePixels(device, scene, width, height, checkFrame - 1);
    checks.push([name, meanDiff(got, now), meanDiff(got, prev)]);
  }
  rb.destroy();
  target.context.unconfigure();
  return { rows, checks, raw };
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const scene = createScene(device);
  const info = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, format: navigator.gpu.getPreferredCanvasFormat() };

  // Which codecs and accelerations the browser says it supports.
  const support: (string | number)[][] = [];
  const supported = new Map<string, boolean>();
  for (const [width, height] of SIZES) {
    for (const codec of CODECS) {
      const answer = async (a: HardwareAcceleration) => (await VideoEncoder.isConfigSupported(fullConfig(codec, width, height, a))).supported ? "yes" : "no";
      const any = await answer("no-preference");
      supported.set(`${codec.name}@${width}`, any === "yes");
      support.push([`${width}x${height}`, codec.name, any, await answer("prefer-hardware"), await answer("prefer-software")]);
    }
  }
  publish("B20: VideoEncoder.isConfigSupported", ["size", "codec", "no-preference", "prefer-hardware", "prefer-software"], support, { adapter: info });

  // Does each path hand over the frame just rendered? Frame 5 against the readback reference of frames 5 and 4.
  const checks: (string | number)[][] = [];
  for (const path of PATHS) {
    const source = makeSource(device, scene, path, 1920, 1080);
    try {
      const frame = await source.single(5);
      const got = pixelsOf(frame, 1920, 1080);
      frame.close();
      const now = await referencePixels(device, scene, 1920, 1080, 5);
      const prev = await referencePixels(device, scene, 1920, 1080, 4);
      checks.push([path, meanDiff(got, now), meanDiff(got, prev)]);
    } catch (e) {
      checks.push([path, `failed: ${String(e)}`, ""]);
    }
    source.destroy();
  }
  publish("B20: VideoFrame check at 1920x1080, mean abs diff per channel (0 = same frame)", ["path", "vs this frame", "vs previous frame"], checks, null);

  const rows: (string | number)[][] = [];
  const raw: Record<string, unknown> = {};
  for (const [width, height] of SIZES) {
    for (const codec of CODECS) {
      if (!supported.get(`${codec.name}@${width}`)) {
        rows.push([`${width}x${height}`, codec.name, "unsupported", 0, 0, 0, 0, 0]);
        continue;
      }
      for (const path of PATHS) {
        const source = makeSource(device, scene, path, width, height);
        try {
          const r = await runVideo(source, fullConfig(codec, width, height, "no-preference"));
          rows.push([`${width}x${height}`, codec.name, path, r.fps, r.main.median, r.main.p95, r.chunks, r.bytes / 1e6]);
          raw[`${width}x${height} ${codec.name} ${path}`] = { fps: r.fps, wallMs: r.wallMs, main: r.main, busy: r.busy, chunks: r.chunks, bytes: r.bytes };
        } catch (e) {
          rows.push([`${width}x${height}`, codec.name, `${path}: failed ${String(e)}`, 0, 0, 0, 0, 0]);
        }
        source.destroy();
      }
    }
  }
  publish(`B20: video export, ${WARMUP} warm-up then ${FRAMES} frames, end to end including flush`, ["size", "codec", "path", "fps", "main ms (median)", "main ms (p95)", "chunks", "MB"], rows, { frames: FRAMES, warmup: WARMUP, runs: raw });

  const still = await stills(device, scene);
  publish(`B20: still 1920x1080 to PNG Blob, ${STILLS} iterations`, ["path", "ms (median)", "ms (p95)", "n", "KB"], still.rows, still.raw);
  publish("B20: PNG check, mean abs diff per channel (0 = same frame)", ["path", "vs this frame", "vs previous frame"], still.checks, null);
  done();
}

run().catch(fail);
