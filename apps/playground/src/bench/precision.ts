// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B15: the engine's two heaviest fragment stages in f32, as they ship, and
// with their colour arithmetic in f16 (`enable f16`), the split the Swift
// engine makes with `half`: positions, shadow coordinates and the tent's
// taps stay f32 in both, the tonal cues, the shadow colour multiplier and
// the fog's blend go to f16.
// - buildings: tile-extruded.wgsl's fragment (the cascades' tent PCF, the
//   self-shadow test, the depth cues, the fog) over six fullscreen layers;
// - ground: the ground's read of the shadow mask (ground-shadow-receiver.wgsl)
//   with the multiplier and the fog over six layers, the stack of fills and
//   roads a street pixel takes.
// The f32 code is the engine's own WGSL (imported raw), so it measures what
// ships. GPU time by timestamp-query, a 2400 x 1720 target.

import groundFog from "../../../../packages/immersive-map/src/ground-fog/shaders/ground-fog.wgsl?raw";
import shadowLibrary from "../../../../packages/immersive-map/src/shadows/shaders/shadow.wgsl?raw";
import { ShadowUniformLayout, writeShadowUniform, type ShadowCascadeUniform } from "../../../../packages/immersive-map/src/shadows/shadow-uniform.ts";
import { done, fail, publish, stat } from "./harness.ts";

const WIDTH = 2400;
const HEIGHT = 1720;
const LAYERS = 6;
const MAP = 4096;

/** The bindings and the per-pixel world point every variant shares. */
const COMMON = /* wgsl */ `
@group(0) @binding(0) var<uniform> shadow: Shadow;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var<uniform> groundFog: GroundFog;
@group(0) @binding(4) var mask: texture_2d<f32>;
@group(0) @binding(5) var maskSampler: sampler;

struct Out { @builtin(position) position: vec4f, @location(0) @interpolate(flat) layer: f32 }

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) layer: u32) -> Out {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return Out(vec4f(p[v], 0.0, 1.0), f32(layer));
}

// A point of the scene under the pixel: metres, a wall or a roof by the pixel.
fn worldPoint(in: Out) -> vec3f {
  return vec3f((in.position.xy - vec2f(${WIDTH / 2}.0, ${HEIGHT / 2}.0)) * 0.5, in.layer * 12.0 + fract(in.position.x * 0.013) * 30.0);
}
fn worldNormal(in: Out) -> vec3f {
  let a = in.position.x * 0.021 + in.position.y * 0.017;
  return normalize(select(vec3f(cos(a), sin(a), 0.0), vec3f(0.0, 0.0, 1.0), fract(in.position.y * 0.01) > 0.6));
}
`;

const BUILDINGS_F32 = /* wgsl */ `
const kWallShadeBase: f32 = 0.90;
const kWallShadeSunSwing: f32 = 0.07;
const kBaseDarkening: f32 = 0.88;
const kGradientRampMeters: f32 = 30.0;
fn cue(n: vec3f, h: f32, l: vec3f) -> f32 {
  let up = saturate(n.z);
  var sunSide = 0.0;
  let nl = length(n.xy);
  let sl = length(l.xy);
  if (nl > 1.0e-3 && sl > 1.0e-3) { sunSide = dot(n.xy / nl, l.xy / sl); }
  let orientation = mix(kWallShadeBase + kWallShadeSunSwing * sunSide, 1.0, up);
  return orientation * mix(kBaseDarkening, 1.0, smoothstep(0.0, kGradientRampMeters, h));
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let p = worldPoint(in);
  let n = worldNormal(in);
  let factor = sampleShadowFactor(shadow, shadowMap, shadowSampler, p, n);
  let applied = mix(1.0, cue(n, min(p.z, 1.0e4), shadow.lightDirection.xyz), factor);
  let color = vec3f(0.9, 0.89, 0.87) * applied * shadowColorMultiplier(shadow, factor);
  return vec4f(applyGroundFog(color, p, groundFog), 1.0);
}`;

const BUILDINGS_F16 = /* wgsl */ `
const kWallShadeBase: f16 = 0.90h;
const kWallShadeSunSwing: f16 = 0.07h;
const kBaseDarkening: f16 = 0.88h;
const kGradientRampMeters: f16 = 30.0h;
fn cue(n: vec3h, h: f16, l: vec3h) -> f16 {
  let up = saturate(n.z);
  var sunSide = 0.0h;
  let nl = length(n.xy);
  let sl = length(l.xy);
  if (nl > 1.0e-3h && sl > 1.0e-3h) { sunSide = dot(n.xy / nl, l.xy / sl); }
  let orientation = mix(kWallShadeBase + kWallShadeSunSwing * sunSide, 1.0h, up);
  return orientation * mix(kBaseDarkening, 1.0h, smoothstep(0.0h, kGradientRampMeters, h));
}
fn multiplierH(strength: f16, tint: vec3h, factor: f16) -> vec3h {
  if (strength <= 0.0h) { return vec3h(1.0h); }
  let amount = saturate((1.0h - factor) / strength);
  return mix(vec3h(1.0h), (1.0h - strength) * tint, amount);
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let p = worldPoint(in);
  let n = worldNormal(in);
  let factor = f16(sampleShadowFactor(shadow, shadowMap, shadowSampler, p, n));
  let nh = vec3h(n);
  let applied = mix(1.0h, cue(nh, f16(min(p.z, 1.0e4)), vec3h(shadow.lightDirection.xyz)), factor);
  let color = vec3h(0.9h, 0.89h, 0.87h) * applied * multiplierH(f16(shadow.eyeAndStrength.w), vec3h(shadow.tint.xyz), factor);
  let amount = f16(groundFogAmount(p, groundFog));
  return vec4f(vec3f(mix(color, vec3h(groundFogColor(p, groundFog)), amount)), 1.0);
}`;

const GROUND_F32 = /* wgsl */ `
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let p = vec3f(worldPoint(in).xy, 0.0);
  var multiplier = vec3f(1.0);
  if (shadow.eyeAndStrength.w > 0.0) {
    let factor = textureSampleLevel(mask, maskSampler, in.position.xy * 0.4 / vec2f(textureDimensions(mask)), 0.0).r;
    multiplier = shadowColorMultiplier(shadow, factor);
  }
  let color = vec3f(0.85 + in.layer * 0.01, 0.84, 0.8) * multiplier;
  return vec4f(applyGroundFog(color, p, groundFog), 0.9);
}`;

const GROUND_F16 = /* wgsl */ `
fn multiplierH(strength: f16, tint: vec3h, factor: f16) -> vec3h {
  if (strength <= 0.0h) { return vec3h(1.0h); }
  let amount = saturate((1.0h - factor) / strength);
  return mix(vec3h(1.0h), (1.0h - strength) * tint, amount);
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let p = vec3f(worldPoint(in).xy, 0.0);
  var multiplier = vec3h(1.0h);
  let strength = f16(shadow.eyeAndStrength.w);
  if (strength > 0.0h) {
    let factor = f16(textureSampleLevel(mask, maskSampler, in.position.xy * 0.4 / vec2f(textureDimensions(mask)), 0.0).r);
    multiplier = multiplierH(strength, vec3h(shadow.tint.xyz), factor);
  }
  let color = vec3h(0.85h + f16(in.layer) * 0.01h, 0.84h, 0.8h) * multiplier;
  let amount = f16(groundFogAmount(p, groundFog));
  return vec4f(vec3f(mix(color, vec3h(groundFogColor(p, groundFog)), amount)), 0.9);
}`;

/** Random boxes into both slices of the shadow map, so the tent's compares see real edges. */
const CASTERS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> @builtin(position) vec4f {
  var h = i * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  let r = vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0;
  let corner = vec2f(f32(v & 1u), f32((v >> 1u) & 1u));
  let size = 0.01 + r.z * 0.03;
  return vec4f((r.xy * 2.0 - 1.0) + corner * size, 0.2 + r.z * 0.6, 1.0);
}`;

function cascade(radius: number, fadeStart: number, fadeEnd: number): ShadowCascadeUniform {
  // World metres to the window's UV, v down, and the depth by the height.
  const m = new Float64Array(16);
  m[0] = 0.5 / radius;
  m[5] = -0.5 / radius;
  m[10] = -1 / 400;
  m[12] = 0.5;
  m[13] = 0.5;
  m[14] = 0.6;
  m[15] = 1;
  const inset = 4 / MAP;
  return {
    worldToShadowTexture: m,
    tentSpread: 1.5,
    fadeStartDistance: fadeStart,
    depthBias: 0.0004,
    fadeEndDistance: fadeEnd,
    uvMinimum: [inset, inset],
    uvMaximum: [1 - inset, 1 - inset],
    normalOffsetWorld: 0.3,
    texelSizeUV: [1 / MAP, 1 / MAP],
  };
}

async function run() {
  const adapter = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }))!;
  if (!adapter.features.has("timestamp-query")) throw new Error("B15 needs timestamp-query");
  const hasF16 = adapter.features.has("shader-f16");
  const device = await adapter.requestDevice({ requiredFeatures: hasF16 ? ["timestamp-query", "shader-f16"] : ["timestamp-query"] });
  const format: GPUTextureFormat = "bgra8unorm";
  const target = device.createTexture({ size: [WIDTH, HEIGHT], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const shadowMap = device.createTexture({ size: [MAP, MAP, 2], format: "depth16unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const maskTexture = device.createTexture({ size: [Math.ceil(WIDTH * 0.4), Math.ceil(HEIGHT * 0.4)], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  {
    const w = maskTexture.width;
    const h = maskTexture.height;
    const row = Math.ceil(w / 256) * 256;
    const bytes = new Uint8Array(row * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bytes[y * row + x] = ((x >> 5) + (y >> 5)) % 3 === 0 ? 170 : 255;
    device.queue.writeTexture({ texture: maskTexture }, bytes, { bytesPerRow: row }, [w, h]);
  }
  // The casters.
  {
    const module = device.createShaderModule({ code: CASTERS });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      primitive: { topology: "triangle-strip" },
      depthStencil: { format: "depth16unorm", depthWriteEnabled: true, depthCompare: "less-equal" },
    });
    const encoder = device.createCommandEncoder();
    for (let layer = 0; layer < 2; layer++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: shadowMap.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1 }), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
      });
      pass.setPipeline(pipeline);
      pass.draw(4, 20_000);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }
  const shadowBuffer = device.createBuffer({ size: ShadowUniformLayout.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const staging = new Float32Array(ShadowUniformLayout.byteLength / 4);
  // The near window over the middle of the frame, the far one beyond it, the band between them reading both.
  writeShadowUniform(staging, 0, {
    near: cascade(500, 300, 400),
    far: cascade(1400, 900, 1200),
    eye: [0, -800, 400],
    strength: 0.22,
    lightDirection: [-0.33, -0.49, 0.81],
    tint: [0.88, 0.92, 1],
    fadeCenter: [0, -100],
  });
  device.queue.writeBuffer(shadowBuffer, 0, staging);
  const fogBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(fogBuffer, 0, new Float32Array([0.8, 0.85, 0.9, 0.0003, 0, -800, 400, 1, 300, 200, 0.8, 1, 0.6, 0.7, 0.9, 0.05, 100, 0, 0, 0]));
  const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: shadowBuffer } },
      { binding: 1, resource: shadowMap.createView({ dimension: "2d-array" }) },
      { binding: 2, resource: device.createSampler({ compare: "less-equal", minFilter: "linear", magFilter: "linear" }) },
      { binding: 3, resource: { buffer: fogBuffer } },
      { binding: 4, resource: maskTexture.createView() },
      { binding: 5, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
    ],
  });
  const pipeline = (fragment: string, f16: boolean, blend: boolean) => {
    const module = device.createShaderModule({ code: [f16 ? "enable f16;" : "", shadowLibrary, groundFog, COMMON, fragment].join("\n") });
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format, ...(blend ? { blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } } : {}) }],
      },
      primitive: { topology: "triangle-list" },
    });
  };
  const variants: [string, string, GPURenderPipeline][] = [
    ["buildings", "f32", pipeline(BUILDINGS_F32, false, false)],
    ["ground", "f32", pipeline(GROUND_F32, false, true)],
  ];
  if (hasF16) variants.push(["buildings", "f16", pipeline(BUILDINGS_F16, true, false)], ["ground", "f16", pipeline(GROUND_F16, true, true)]);

  const frames = Number(new URLSearchParams(location.search).get("frames") ?? 200);
  const samples = new Map<string, number[]>();
  // Interleaved: every round draws each variant once, so a clock change hits all alike.
  for (let f = 0; f < frames + 20; f++) {
    for (const [scene, precision, p] of variants) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      });
      pass.setPipeline(p);
      pass.setBindGroup(0, group);
      pass.draw(3, LAYERS);
      pass.end();
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const [a, b] = new BigInt64Array(readback.getMappedRange());
      readback.unmap();
      const key = `${scene}|${precision}`;
      if (f >= 20) (samples.get(key) ?? samples.set(key, []).get(key)!).push(Number(b! - a!) / 1e6);
    }
  }
  const rows: (string | number)[][] = [];
  const raw: unknown[] = [];
  for (const [key, values] of samples) {
    const [scene, precision] = key.split("|");
    const s = stat(values);
    rows.push([`${scene}, ${LAYERS} layers, ${WIDTH}x${HEIGHT}`, precision!, s.median, s.p95]);
    raw.push({ scene, precision, gpu: s });
  }
  if (!hasF16) rows.push(["(no shader-f16 on this adapter)", "f16", "n/a", "n/a"]);
  publish("B15: GPU ms per pass, f32 against f16", ["scene", "precision", "GPU median ms", "GPU p95 ms"], rows, { hasF16, raw });
  done();
}

run().catch(fail);
