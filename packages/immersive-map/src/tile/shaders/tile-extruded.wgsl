// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ../../shadows/shaders/shadow.wgsl ../../ground-fog/shaders/ground-fog.wgsl standing-frame.wgsl

// The extruded buildings of the flat map, a port of the Swift engine's
// TileExtruded.metal: opaque, with a regular depth test, into the world
// pass, and the same geometry depth-only from the light's camera into the
// shadow map. Faces keep their flat base colour and darken where the
// shadow map says the sun is occluded, with two tonal cues on top. On the
// ground relief (kExtrudedRelief) each building stands level at the
// terrain's height under its anchor.

// The CPU quantizes positions to quarter tile units (14.2 fixed point).
const kExtrudedPositionInverseScale: f32 = 0.25;

/// The ground relief (GroundReliefStore): the building rises by its lift,
/// one per building of the tile (buildingLifts, the terrain's metres under
/// its anchor, BuildingReliefLifts), the metres less the frame's datum,
/// times the frame's strength and the world units a metre spans, so it
/// stands level on the slope under it.
override kExtrudedRelief: bool = false;

// What a tile's lifts are drawn with this frame: the world units a metre
// spans, the datum in metres (the terrain under the point the camera looks
// at) and the frame's strength, as the ground's (ground-relief.wgsl).
struct BuildingLift {
    unitsPerMetre: f32,
    datumMetres: f32,
    strength: f32,
    padding: f32,
}

// One draw, read at the draw's instance index (its firstInstance): the
// tile's model matrix with the rise in its z scale (the world pass), or the
// light's projection-view times it (the casters), the world units a metre
// of height spans for the depth cue, and the model's z scale, which a lift
// in world units is divided by to rise in the tile's own units.
struct BuildingDraw {
    model: mat4x4f,
    metersToWorldZ: f32,
    modelZScale: f32,
    padding1: f32,
    padding2: f32,
}

@group(1) @binding(0) var<storage, read> draws: array<BuildingDraw>;
@group(2) @binding(0) var<storage, read> styles: array<vec4f>;
@group(3) @binding(0) var<storage, read> buildingLifts: array<f32>;
@group(3) @binding(1) var<uniform> buildingLift: BuildingLift;

// The tile-local z a building rises by on the relief: its lift's metres
// over the datum at the frame's strength, in world units, over the model's
// z scale. Zero on the plane.
fn buildingLiftLocalZ(ordinal: u32, modelZScale: f32) -> f32 {
    if (!kExtrudedRelief || modelZScale <= 0.0) {
        return 0.0;
    }
    let lift = buildingLifts[min(ordinal, arrayLength(&buildingLifts) - 1u)];
    return (lift - buildingLift.datumMetres) * buildingLift.strength * buildingLift.unitsPerMetre / modelZScale;
}

// The 12-byte ExtrudedVertexIn: the position as raw sint16 (fetched as four,
// the fourth the normal's first bytes, unused), the normal as snorm8, the
// style index and the building's ordinal (the relief's lifts).
struct ExtrudedVertexIn {
    @location(0) position: vec4i,
    @location(1) normalXY: vec2f,
    @location(2) normalZ: f32,
    @location(3) styleIndex: u32,
    @location(4) buildingOrdinal: u32,
}

struct ExtrudedVertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPosition: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) @interpolate(flat) color: vec3f,
    @location(3) @interpolate(flat) metersToWorldZ: f32,
    // The world z of the ground the building stands on, its lift: the depth cue counts the height from it.
    @location(4) @interpolate(flat) groundZ: f32,
}

@vertex
fn tileExtrudedVertex(in: ExtrudedVertexIn, @builtin(instance_index) drawIndex: u32) -> ExtrudedVertexOut {
    let draw = draws[drawIndex];
    var localPosition = vec3f(in.position.xyz) * kExtrudedPositionInverseScale;
    localPosition.z += buildingLiftLocalZ(in.buildingOrdinal, draw.modelZScale);
    let worldPosition = draw.model * vec4f(localPosition, 1.0);
    let normalMatrix = mat3x3f(draw.model[0].xyz, draw.model[1].xyz, draw.model[2].xyz);
    var out: ExtrudedVertexOut;
    out.position = camera.matrix * worldPosition;
    out.worldPosition = worldPosition.xyz;
    out.worldNormal = normalize(normalMatrix * vec3f(in.normalXY, in.normalZ));
    out.color = styles[in.styleIndex].rgb;
    out.metersToWorldZ = draw.metersToWorldZ;
    out.groundZ = buildingLiftLocalZ(in.buildingOrdinal, draw.modelZScale) * draw.modelZScale;
    return out;
}

// Depth cues without a lighting model: roofs keep the base colour, walls
// darken a step, the sun-facing side of a wall lighter than the far side,
// so roof, lit wall, side wall and shaded wall are four distinct tones, and
// walls darken toward the ground over the first 30 m (the ambient occlusion
// of street canyons). Both never exceed 1.
const kWallShadeBase: f32 = 0.90;
const kWallShadeSunSwing: f32 = 0.07;
const kBaseDarkening: f32 = 0.88;
const kGradientRampMeters: f32 = 30.0;

fn extrudedDepthCueShade(worldNormal: vec3f, heightMeters: f32, lightDirection: vec3f) -> f32 {
    let upness = saturate(worldNormal.z);
    var sunSide = 0.0;
    let normalLength = length(worldNormal.xy);
    let sunLength = length(lightDirection.xy);
    if (normalLength > 1.0e-3 && sunLength > 1.0e-3) {
        sunSide = dot(worldNormal.xy / normalLength, lightDirection.xy / sunLength);
    }
    let wallShade = kWallShadeBase + kWallShadeSunSwing * sunSide;
    let orientationShade = mix(wallShade, 1.0, upness);
    let gradient = mix(kBaseDarkening, 1.0, smoothstep(0.0, kGradientRampMeters, heightMeters));
    return orientationShade * gradient;
}

// The flat base colour darkened where the static sun is occluded: walls
// turned from the sun are self-shadowed by the same factor as cast shadows.
// The cues fade out with the shadow, so a shadowed face keeps the pure
// shadow colour, tinted as the ground under it is.
@fragment
fn tileExtrudedFragment(in: ExtrudedVertexOut) -> @location(0) vec4f {
    let normal = normalize(in.worldNormal);
    let shadowFactor = sampleShadowFactor(shadow, shadowMap, shadowSampler, in.worldPosition, normal);
    let heightMeters = (in.worldPosition.z - in.groundZ) / max(in.metersToWorldZ, 1e-9);
    let depthCueShade = extrudedDepthCueShade(normal, min(heightMeters, 1.0e4), shadow.lightDirection.xyz);
    let appliedCue = mix(1.0, depthCueShade, shadowFactor);
    let color = in.color * appliedCue * shadowColorMultiplier(shadow, shadowFactor);
    return vec4f(applyGroundFog(color, in.worldPosition, buildingFog), 1.0);
}

// The casters: the record's matrix is the light's projection-view times the
// tile's, and a caster nearer than the fitted near plane is pancaked onto
// it (the Metal depth clamp), so a tower taller than the fit still casts.
@vertex
fn tileExtrudedShadowVertex(@location(0) position: vec4i, @location(4) buildingOrdinal: u32, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    let draw = draws[drawIndex];
    var localPosition = vec3f(position.xyz) * kExtrudedPositionInverseScale;
    localPosition.z += buildingLiftLocalZ(buildingOrdinal, draw.modelZScale);
    let clip = draw.model * vec4f(localPosition, 1.0);
    return vec4f(clip.xy, clamp(clip.z, 0.0, clip.w), clip.w);
}
