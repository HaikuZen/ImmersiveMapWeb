// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ../../globe/shaders/clip-distances.wgsl ../../shadows/shaders/shadow.wgsl ../../ground-fog/shaders/ground-fog.wgsl ../../tile/shaders/standing-frame.wgsl

// The models of a model tile (ModelTileContents), a port of the Swift
// engine's ModelTile.metal: every model of the tile is merged into one
// vertex buffer and one index buffer, in the tile's own space, with one
// texture array. A vertex says which layer of the array its texture is, so
// the whole tile draws in one call under one matrix, the tile's, with no
// bind between its models.
//
// Tile space is the flat map's: X east, Y north, Z up from the ground. A
// vertex keeps its position as a place in the tile's bounding box, and the
// draw's matrix takes it from there: the box's size and minimum into tile
// space, then a translation and a uniform scale, the ones the map's own
// buildings of the same tile take, so the models lie on the flat map as the
// buildings do. They draw on the flat map only, as the buildings do.
//
// A model is drawn a little nearer in depth than it stands (depthBias, a
// share of its distance from the eye): every vertex moves toward the eye
// along its own ray, which leaves it where it was on the screen and takes
// only its depth forward. The map's own building a model stands in for,
// where a tile did not leave it out, reaches a little out of the model, and
// this is what puts the model over it. The shadow takes a vertex where it
// stands.

// The clipped variant: what is below the ground, the plane Z = 0, is not
// drawn. A tile coming up out of the ground (ExtrusionRise) is drawn
// lowered, and the flat ground writes no real depth, so what is still below
// the surface would show through it. Its own pipeline. Where the device has
// `clip-distances` the plane is a clip distance (the height is linear in the
// position, so the rasterizer cuts exactly there) and the draw keeps early
// depth, which a million-triangle tile rising needs. Elsewhere the fragment
// is discarded by the interpolated height, as in Swift.
override kModelTileClipsBelowGround: bool = false;

// One draw, read at the draw's instance index (its firstInstance): the
// tile's stored positions into the flat world (the world pass) or into the
// light's clip space (the casters), and the depth bias.
struct ModelTileDraw {
    model: mat4x4f,
    depthBias: f32,
    padding0: f32,
    padding1: f32,
    padding2: f32,
}

@group(1) @binding(0) var<storage, read> modelTileDraws: array<ModelTileDraw>;
@group(2) @binding(0) var baseColorTextures: texture_2d_array<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;

// The 16-byte vertex of a model tile, read through the formats WebGPU has:
// the position as three of four unsigned normalized shorts (the fourth the
// texture's u), the texture coordinate as the middle two of the four from
// byte 4, the normal as two signed normalized bytes and one, the layer.
struct ModelTileVertexIn {
    @location(0) position: vec4f,
    @location(1) shortsFromFour: vec4f,
    @location(2) normalXY: vec2f,
    @location(3) normalZ: f32,
    @location(4) layer: u32,
}

struct ModelTileVertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPosition: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) uv: vec2f,
    @location(3) @interpolate(flat) layer: u32,
    @builtin(clip_distances) groundClip: array<f32, 1>, // clip-distances
}

struct ModelTileFragmentIn {
    @location(0) worldPosition: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) uv: vec2f,
    @location(3) @interpolate(flat) layer: u32,
}

@vertex
fn modelTileVertex(in: ModelTileVertexIn, @builtin(instance_index) drawIndex: u32) -> ModelTileVertexOut {
    let draw = modelTileDraws[drawIndex];
    let worldPosition = draw.model * vec4f(in.position.xyz, 1.0);
    let drawnPosition = worldPosition.xyz + (camera.eye - worldPosition.xyz) * draw.depthBias;
    var out: ModelTileVertexOut;
    out.position = camera.matrix * vec4f(drawnPosition, 1.0);
    out.worldPosition = worldPosition.xyz;
    // The normal is in tile space already, apart from the position's box,
    // and a translation and a uniform scale leave a direction as it is.
    out.worldNormal = vec3f(in.normalXY, in.normalZ);
    // V down: the origin is the top left of the image, as WebGPU samples.
    out.uv = in.shortsFromFour.yz;
    out.layer = in.layer;
    out.groundClip[0] = select(1.0, worldPosition.z, kModelTileClipsBelowGround); // clip-distances
    return out;
}

// The casters: the record's matrix is the light's projection-view times the
// tile's, and a caster nearer than the fitted near plane is pancaked onto
// it (the Metal depth clamp).
@vertex
fn modelTileShadowVertex(@location(0) position: vec4f, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    let clip = modelTileDraws[drawIndex].model * vec4f(position.xyz, 1.0);
    return vec4f(clip.xy, clamp(clip.z, 0.0, clip.w), clip.w);
}

// No analytic lighting, matching the building extrusion and the scene
// models: the texture's colour darkens only where the shadow map says the
// sun is occluded. The channel values are sampled raw, with no sRGB decode,
// as every model texture is.
@fragment
fn modelTileFragment(in: ModelTileFragmentIn) -> @location(0) vec4f {
    // Sampled before the discard, in uniform control flow.
    let base = textureSample(baseColorTextures, baseColorSampler, in.uv, in.layer);
    if (kModelTileClipsBelowGround && in.worldPosition.z < 0.0) { discard; } // no-clip-distances
    let shadowFactor = sampleShadowFactor(shadow, shadowMap, shadowSampler, in.worldPosition, normalize(in.worldNormal));
    let lit = base.rgb * shadowColorMultiplier(shadow, shadowFactor);
    return vec4f(applyGroundFog(lit, in.worldPosition, buildingFog), 1.0);
}
