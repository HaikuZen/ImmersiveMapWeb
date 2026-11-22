// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The placement prepass on the plane: every placement's square marked in the
// tile-priority stencil with its source's zoom, coarse squares first so a
// finer mark lies over a coarser one. No colour, no depth: the stencil state
// writes the reference through the priority bits. A port of the flat path of
// the Swift engine's PlacementStencilRenderSubsystem.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

struct TileDraw {
    model: mat4x4f,
    depthOffset: f32,
    depthRankStep: f32,
    alphaScale: f32,
    dashUnitsPerPoint: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<storage, read> draws: array<TileDraw>;

// The square's two triangles, counter-clockwise in render space (y up).
const kCorners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(4096.0, 0.0), vec2f(4096.0, 4096.0),
    vec2f(0.0, 0.0), vec2f(4096.0, 4096.0), vec2f(0.0, 4096.0),
);

@vertex
fn placementVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    return camera.matrix * (draws[drawIndex].model * vec4f(kCorners[index], 0.0, 1.0));
}

@fragment
fn placementFragment() -> @location(0) vec4f {
    return vec4f(0.0);
}
