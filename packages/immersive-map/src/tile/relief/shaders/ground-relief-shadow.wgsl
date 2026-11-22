// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ground-relief.wgsl

// The ground relief as a shadow caster (GroundReliefShadowCasterSubsystem),
// the tileRasterReliefShadowVertexShader of the Swift engine's
// TileRaster.metal: the raster tiles' grid over a placement's square,
// raised by the terrain as the ground is, seen from the light. Depth only.

// One draw: the light's projection-view times the square's model matrix,
// and the light's projection-view's z column, which a lift in world units
// moves the clip position by (the record's four scalars).
struct ReliefCasterDraw {
    lightModel: mat4x4f,
    lightUp: vec4f,
}

@group(1) @binding(0) var<storage, read> draws: array<ReliefCasterDraw>;

// A caster nearer than the fitted near plane is pancaked onto it (the Metal
// depth clamp the buildings' casters take too): a mountain behind the
// light's near plane still casts.
@vertex
fn groundReliefShadowVertex(@location(0) localPosition: vec2f, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    let draw = draws[drawIndex];
    let clip = draw.lightModel * vec4f(localPosition, 0.0, 1.0) + draw.lightUp * groundReliefLift(localPosition);
    return vec4f(clip.xy, clamp(clip.z, 0.0, clip.w), clip.w);
}
