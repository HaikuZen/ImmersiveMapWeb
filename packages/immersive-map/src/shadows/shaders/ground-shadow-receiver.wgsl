// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// library
// How the flat ground reads its shadow: one bilinear tap of the ground
// shadow mask (ground-shadow-mask.wgsl) at the pixel, or on the relief the
// shadow map at the raised point, the tileGroundShadowFactor of the Swift
// engine's Tile.metal and TileRaster.metal. The bindings are the
// tile pipelines' frame group (FlatTilePipelines.frameLayout). Prepended
// after shadow.wgsl.

// Mask pixels per drawable pixel, mirrored by GroundShadowMask.resolutionScale.
const kGroundShadowMaskScale: f32 = 0.4;

// The frame's shadows: the disabled uniform (strength 0) on a frame
// without the mask pass, so the mask is never read then.
@group(0) @binding(4) var<uniform> shadow: Shadow;
@group(0) @binding(5) var groundShadowMask: texture_2d<f32>;
@group(0) @binding(6) var groundShadowMaskSampler: sampler;
// The shadow map's windows, which the ground relief samples at its raised
// points (the mask is the plane's shadow).
@group(0) @binding(7) var groundShadowMap: texture_depth_2d_array;
@group(0) @binding(8) var groundShadowMapSampler: sampler_comparison;

// The colour multiplier of the ground at a fragment's pixel.
fn tileGroundShadowMultiplier(fragmentPosition: vec4f) -> vec3f {
    if (shadow.eyeAndStrength.w <= 0.0) {
        return vec3f(1.0);
    }
    let uv = fragmentPosition.xy * kGroundShadowMaskScale / vec2f(textureDimensions(groundShadowMask));
    let factor = textureSampleLevel(groundShadowMask, groundShadowMaskSampler, uv, 0.0).r;
    return shadowColorMultiplier(shadow, factor);
}

// The colour multiplier of the ground relief at a raised world point: the
// shadow map's windows at the point itself, with no normal (the ground
// always faces the sun and keeps its tight contact).
fn tileReliefShadowMultiplier(worldPosition: vec3f) -> vec3f {
    if (shadow.eyeAndStrength.w <= 0.0) {
        return vec3f(1.0);
    }
    return shadowColorMultiplier(shadow, sampleShadowFactor(shadow, groundShadowMap, groundShadowMapSampler, worldPosition, vec3f(0.0)));
}
