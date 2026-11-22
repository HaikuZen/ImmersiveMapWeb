// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: shadow.wgsl

// The ground shadow mask, a port of the Swift engine's GroundShadowMask.metal:
// the shadow factor of the flat ground plane (z = 0), one value per mask
// pixel, written once a frame by one fullscreen triangle. Every ground layer
// of the flat map lies on that plane, so its shadow is a function of the
// pixel alone, and the ground fragments read it with one bilinear tap
// instead of each sampling the cascades again (tile.wgsl, tile-raster.wgsl).
// The buildings and the trees keep sampling the cascades: their surfaces are
// not the plane.

// Mirrored by GroundShadowMaskUniformLayout (shadows/ground-shadow-mask.ts).
struct GroundShadowMaskUniform {
    // The camera's projection-view inverted: NDC back to world space.
    inverseProjectionView: mat4x4f,
    // The mask's size in pixels.
    viewportSize: vec2f,
    padding: vec2f,
}

@group(0) @binding(0) var<uniform> mask: GroundShadowMaskUniform;
@group(0) @binding(1) var<uniform> shadow: Shadow;
@group(0) @binding(2) var shadowMap: texture_depth_2d_array;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

@vertex
fn groundShadowMaskVertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// The pixel's view ray meets the ground plane and the windows are sampled
// there. The plane faces up, so there is no normal handling: the factor is
// 1 - (1 - mapVisibility) * strength * fade, and nothing takes a derivative,
// so the early returns are free.
@fragment
fn groundShadowMaskFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let ndc = vec2f(2.0 * position.x / mask.viewportSize.x - 1.0, 1.0 - 2.0 * position.y / mask.viewportSize.y);
    let nearPoint = mask.inverseProjectionView * vec4f(ndc, 0.0, 1.0);
    let farPoint = mask.inverseProjectionView * vec4f(ndc, 1.0, 1.0);
    let rayStart = nearPoint.xyz / nearPoint.w;
    let rayDirection = farPoint.xyz / farPoint.w - rayStart;
    if (abs(rayDirection.z) <= 1e-12) {
        return vec4f(1.0);
    }
    let t = -rayStart.z / rayDirection.z;
    if (t < 0.0 || t > 1.0) {
        return vec4f(1.0);
    }
    let worldPosition = vec3f((rayStart + rayDirection * t).xy, 0.0);
    let strength = shadow.eyeAndStrength.w;
    if (strength <= 0.0) {
        return vec4f(1.0);
    }
    let blend = shadowCascadeBlend(shadow, worldPosition.xy);
    if (blend.y <= 0.0) {
        return vec4f(1.0);
    }
    let mapVisibility = shadowMapVisibility(shadow, shadowMap, shadowSampler, worldPosition, vec3f(0.0), blend);
    return vec4f(1.0 - (1.0 - mapVisibility) * strength * blend.y);
}
