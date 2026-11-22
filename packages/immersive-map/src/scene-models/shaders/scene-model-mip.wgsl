// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The mip chain of a scene model's base colour texture (SceneModelGpuMesh):
// WebGPU has no generated mipmaps (the Swift loader asks MetalKit for
// them), so each level is drawn from the one above by a triangle over the
// whole level, a bilinear sample at the centre of every texel, which over a
// level of half the side is the average of the four texels under it.

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

struct SceneModelMipOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn sceneModelMipVertex(@builtin(vertex_index) index: u32) -> SceneModelMipOut {
    // One triangle past the level's corners: uv 0 to 1 over the level, v down.
    let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    var out: SceneModelMipOut;
    out.position = vec4f(corner * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    out.uv = corner;
    return out;
}

@fragment
fn sceneModelMipFragment(in: SceneModelMipOut) -> @location(0) vec4f {
    return textureSampleLevel(source, sourceSampler, in.uv, 0.0);
}
