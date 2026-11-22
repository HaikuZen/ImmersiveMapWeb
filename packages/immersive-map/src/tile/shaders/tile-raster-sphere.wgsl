// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: ../../globe/shaders/clip-distances.wgsl ../../globe/shaders/globe.wgsl
// A tile's grid (RasterTileGrid) on the globe: the raster rings' texture on
// the resting sphere and through the unroll, and the placement prepass's
// marks, which lie where the ground lies. A port of the sphere draws of the
// Swift engine's TileRaster.metal (tileRasterSpherePure/Morph).

/// The unroll toward the plane (transition above 0). Off on the resting sphere.
override kGlobeMorph: bool = false;
/// Added to the mip level the GPU picks (RasterizationSettings.mipLevelBias).
override kTileRasterMipLevelBias: f32 = 0.0;

const kTileRasterExtent: f32 = 4096.0;
// The sphere's rank depth step (tile-sphere.wgsl): the raster tile takes the first rank.
const kTileRasterSphereLayerDepthStep: f32 = 3.2e-6;

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// The draw record's view on the sphere: the tile's place in the world uv
/// in the first row (GlobeSurfaceTile).
struct SphereGridDraw {
    uvOrigin: vec2f,
    uvScale: f32,
    referenceWorldX: f32,
    unused: array<vec4f, 4>,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(3) var<uniform> globe: GlobeFrame;
@group(1) @binding(0) var<storage, read> draws: array<SphereGridDraw>;
@group(2) @binding(0) var raster: texture_2d<f32>;
@group(2) @binding(1) var rasterSampler: sampler;

struct SphereGridVertexOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) uv: vec2f,
    @location(1) sphereNormal: vec3f,
    @location(2) cutClearance: f32, // no-clip-distances
}

struct SphereGridFragmentIn {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) sphereNormal: vec3f,
    @location(2) cutClearance: f32, // no-clip-distances
}

/// The texture coordinate of a tile-local position: x east, v from the
/// tile's north edge, where the texture's first row is.
fn tileRasterTextureUv(localPosition: vec2f) -> vec2f {
    return vec2f(localPosition.x, kTileRasterExtent - localPosition.y) / kTileRasterExtent;
}

@vertex
fn tileRasterSphereVertex(@location(0) localPosition: vec2f, @builtin(instance_index) drawIndex: u32) -> SphereGridVertexOut {
    let draw = draws[drawIndex];
    let uv = tileRasterTextureUv(localPosition);
    let point = globeSurfacePoint(draw.uvOrigin + uv * draw.uvScale, draw.referenceWorldX, kGlobeMorph, globe);
    var out: SphereGridVertexOut;
    out.position = globeSurfaceClip(point, kGlobeMorph, camera.matrix, globe);
    out.position.z = (1.0 - kTileRasterSphereLayerDepthStep) * out.position.w;
    out.cut[0] = point.clearance; // clip-distances
    out.cutClearance = point.clearance; // no-clip-distances
    out.uv = uv;
    out.sphereNormal = point.normal;
    return out;
}

/// The raster tile, opaque, under the globe's light.
@fragment
fn tileRasterSphereFragment(in: SphereGridFragmentIn) -> @location(0) vec4f {
    if (kGlobeMorph && in.cutClearance < 0.0) { discard; } // no-clip-distances
    let color = textureSampleBias(raster, rasterSampler, in.uv, kTileRasterMipLevelBias);
    return vec4f(globeLitColor(color.rgb, in.sphereNormal, globe), 1.0);
}

/// The placement marks: no colour (the pipeline writes none), the stencil
/// state writes the source's reference.
@fragment
fn placementSphereFragment(in: SphereGridFragmentIn) -> @location(0) vec4f {
    if (kGlobeMorph && in.cutClearance < 0.0) { discard; } // no-clip-distances
    return vec4f(0.0);
}
