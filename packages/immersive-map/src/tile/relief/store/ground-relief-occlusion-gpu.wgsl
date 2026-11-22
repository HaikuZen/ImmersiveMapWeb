// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The terrain's occlusion of the sky (decision B10), the Swift
// `GroundReliefOcclusion.compute` as a compute shader over the relief's
// r16float height texture: one invocation per point of the grid, the same
// rays (the texel offsets and one over the metres of each step, built on
// the CPU by ground-relief-occlusion-gpu.ts), the same loop order and the
// same rounding, so the bytes are the Swift engine's. They go into a
// storage buffer of rows padded to 256 bytes, four to a word, which is
// copied into the r8unorm texture the fills sample.

struct Params {
  size: u32,
  resolution: u32,
  directions: u32,
  stepCount: u32,
  share: f32,
  rowWords: u32,
}

@group(0) @binding(0) var heights: texture_2d<f32>;
// x and y offsets in texels (as bits), one over the step's metres, per direction and step.
@group(0) @binding(1) var<storage, read> rays: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> occlusion: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let resolution = params.resolution;
  if (id.x >= resolution || id.y >= resolution) {
    return;
  }
  let size = i32(params.size);
  // (column + 0.5) * size / resolution, truncated, in integers.
  let x = i32(((2u * id.x + 1u) * params.size) / (2u * resolution));
  let y = i32(((2u * id.y + 1u) * params.size) / (2u * resolution));
  let base = textureLoad(heights, vec2i(x, y), 0).r;
  var sum = 0.0;
  var index = 0u;
  for (var direction = 0u; direction < params.directions; direction++) {
    var steepest = 0.0;
    for (var step = 0u; step < params.stepCount; step++) {
      let ray = rays[index + step];
      let sample = vec2i(x, y) + bitcast<vec2i>(ray.xy);
      if (any(sample < vec2i(0)) || any(sample >= vec2i(size))) {
        break;
      }
      let slope = (textureLoad(heights, sample, 0).r - base) * ray.z;
      if (slope > steepest) {
        steepest = slope;
      }
    }
    sum += steepest / sqrt(1.0 + steepest * steepest);
    index += params.stepCount;
  }
  // Rounded half away from zero (the value is never negative), then clamped.
  let scaled = sum * params.share;
  var rounded = floor(scaled);
  if (scaled - rounded >= 0.5) {
    rounded += 1.0;
  }
  let value = u32(clamp(rounded, 0.0, 255.0));
  atomicOr(&occlusion[id.y * params.rowWords + id.x / 4u], value << (8u * (id.x % 4u)));
}
