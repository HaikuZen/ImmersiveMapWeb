// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ../../ground-fog/shaders/ground-fog.wgsl ../../shadows/shaders/shadow.wgsl ../../shadows/shaders/ground-shadow-receiver.wgsl ../relief/shaders/ground-relief.wgsl

// The raster tiles' draw on the plane (RasterTileRenderSubsystem): the
// tile's texture on a grid in the tile's place, opaque, at a depth half a
// rank step behind the ground's first. A port of the flat draw of the Swift
// engine's TileRaster.metal: the texture under the ground shadow mask and
// the ground fog, as the vector ground, or on the relief (kTileRasterRelief)
// raised as the vector ground is, its slopes shaded and its valleys
// darkened, under the shadow map's windows at the raised point.

/// Added to the mip level the GPU picks (RasterizationSettings.mipLevelBias).
override kTileRasterMipLevelBias: f32 = 0.0;
/// The raster tile on the ground relief (GroundReliefStore): the grid's
/// vertex rises by the terrain's height under it, read from the relief's
/// texture, as a flattened vector tile's does (tile.wgsl).
override kTileRasterRelief: bool = false;

const kTileRasterExtent: f32 = 4096.0;
// The flat rank depth, one value with tile.wgsl (kFlatTileLayerDepthStep,
// kFlatRealDepthScale): the raster tile lies half a step behind the ground
// band's first step, where the opaque fills of a vector tile lie. Not on
// it: a vector tile drawn over the raster (a finer tile reaching into the
// raster ring) is then nearer by a margin and wins its ground outright,
// where at the same depth the two would meet at the last bits of z.
const kTileRasterFlatLayerDepthStep: f32 = 3.2e-6;
const kTileRasterBehindFillsShare: f32 = 0.5;
const kTileRasterFlatRealDepthScale: f32 = 1.0 - 1536.0 * kTileRasterFlatLayerDepthStep;
// The relief's depth, one value with tile.wgsl (kReliefBandScale,
// kReliefGroundBehind): the raised ground keeps the real geometry's depth
// scale, at the band's first step.
const kTileRasterReliefBandScale: f32 = 0.25;
const kTileRasterReliefGroundBehind: f32 = 2.0 * kTileRasterFlatLayerDepthStep;

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One draw, read at the draw's instance index (its firstInstance): the
/// tile's model matrix. The rest of the record is the vector ground's.
struct TileDraw {
    model: mat4x4f,
    depthOffset: f32,
    depthRankStep: f32,
    alphaScale: f32,
    dashUnitsPerPoint: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(2) var<uniform> groundFog: GroundFog;
@group(1) @binding(0) var<storage, read> draws: array<TileDraw>;
@group(2) @binding(0) var raster: texture_2d<f32>;
@group(2) @binding(1) var rasterSampler: sampler;

struct TileRasterVertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) worldPosition: vec3f,
}

/// The texture coordinate of a tile-local position: x east, v from the
/// tile's north edge, where the texture's first row is.
fn tileRasterTextureUv(localPosition: vec2f) -> vec2f {
    return vec2f(localPosition.x, kTileRasterExtent - localPosition.y) / kTileRasterExtent;
}

@vertex
fn tileRasterFlatVertex(@location(0) localPosition: vec2f, @builtin(instance_index) drawIndex: u32) -> TileRasterVertexOut {
    var worldPosition = draws[drawIndex].model * vec4f(localPosition, 0.0, 1.0);
    if (kTileRasterRelief) {
        worldPosition.z += groundReliefLift(localPosition);
    }
    var out: TileRasterVertexOut;
    out.position = camera.matrix * worldPosition;
    let step = kTileRasterFlatLayerDepthStep * kTileRasterBehindFillsShare;
    if (kTileRasterRelief) {
        // The relief's depth half a step behind the ground band's first
        // step, where the vector ground's opaque fills over a relief lie.
        out.position.z *= 1.0 + kTileRasterReliefGroundBehind - step * kTileRasterReliefBandScale;
    } else {
        // The plane's depth scaled to half a step behind the ground band's
        // first step, where the vector ground's opaque fills lie (tile.wgsl).
        out.position.z *= (1.0 - step) / kTileRasterFlatRealDepthScale;
    }
    out.uv = tileRasterTextureUv(localPosition);
    out.worldPosition = worldPosition.xyz;
    return out;
}

@fragment
fn tileRasterFlatFragment(in: TileRasterVertexOut) -> @location(0) vec4f {
    let color = textureSampleBias(raster, rasterSampler, in.uv, kTileRasterMipLevelBias);
    var rgb = color.rgb;
    var shadowMultiplier: vec3f;
    if (kTileRasterRelief) {
        // The slopes shaded as the vector ground's fills shade them: the
        // texture's uv is the tile's (tileRasterTextureUv, groundReliefTileUV).
        let shadingUV = relief.shading.xy + saturate(in.uv) * relief.shading.z;
        rgb = groundReliefHillshade(rgb, shadingUV, in.worldPosition);
        rgb = groundReliefOcclude(rgb, shadingUV);
        // The mask is the plane's shadow: on the relief the shadow map is
        // sampled at the raised point itself.
        shadowMultiplier = tileReliefShadowMultiplier(in.worldPosition);
    } else {
        shadowMultiplier = tileGroundShadowMultiplier(in.position);
    }
    return vec4f(applyGroundFog(rgb * shadowMultiplier, in.worldPosition, groundFog), 1.0);
}
