// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ../../globe/shaders/clip-distances.wgsl ../../shadows/shaders/shadow.wgsl ../../ground-fog/shaders/ground-fog.wgsl ../../tile/shaders/standing-frame.wgsl

// The app's scene models, a port of the Swift engine's SceneModel.metal.
// The sphere-to-plane morph is evaluated once per model anchor on the CPU
// (SceneModelAnchorMath) and arrives baked into the model matrix, so the
// model stays rigid through the morph and this shader is a plain rigid-body
// path.
//
// The ground cut (ImmersiveMapSceneModel.cutsIntoGround). The flat ground
// writes no real depth, only a rank band at the far plane, so it hides
// nothing: a model sunk below the surface would show its underground part
// through the ground from every side. A model that cuts into the ground
// draws in four steps, all in the world pass (SceneModelRenderSubsystem):
// its own mesh flattened onto the ground plane raises the ground hole
// stencil bit over its outline (sceneModelGroundFootprintVertex), the mesh
// draws whole where the bit is raised, the mesh draws again where the bit
// is clear with every fragment below the surface dropped
// (kSceneModelClipsBelowGround), and the flattened mesh lowers the bit
// again. A fragment below the surface thus shows only in pixels whose view
// ray enters the ground inside the outline, which is the pit seen from
// above, and never where the ray meets intact ground beside the model.

// The clipped variant: what is below the ground is not drawn. Its own
// pipeline. A clip distance by the height above the ground plane where the
// device has `clip-distances` (the draw keeps early depth), a discard by
// the interpolated height elsewhere, as in Swift.
override kSceneModelClipsBelowGround: bool = false;

// One draw of one submesh, at the draw's instance index (its firstInstance):
// the mesh's model matrix (the light's projection-view times it for the
// casters), the map surface under the anchor at altitude zero and the local
// up (Swift SceneModelGroundPlane), and the submesh's base colour.
struct SceneModelDraw {
    model: mat4x4f,
    groundSurface: vec4f,
    groundUp: vec4f,
    baseColor: vec4f,
    padding: vec4f,
}

@group(1) @binding(0) var<storage, read> sceneModelDraws: array<SceneModelDraw>;
@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;

// The canonical interleaved vertex (SceneModelAssetData, 32 bytes).
struct SceneModelVertexIn {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
}

struct SceneModelVertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPosition: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) uv: vec2f,
    // Height above the map surface under the anchor, in render units:
    // negative below the ground. Linear in the position, so it interpolates
    // exactly.
    @location(3) groundHeight: f32,
    @location(4) @interpolate(flat) baseColor: vec4f,
    @builtin(clip_distances) groundClip: array<f32, 1>, // clip-distances
}

struct SceneModelFragmentIn {
    @location(0) worldPosition: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) uv: vec2f,
    @location(3) groundHeight: f32,
    @location(4) @interpolate(flat) baseColor: vec4f,
}

// The normals' matrix of a model matrix: the cofactors of its upper 3x3,
// which are its inverse transpose times its determinant, the sign of the
// determinant kept so a mirrored node keeps its normals outward. Node
// transforms may carry a non-uniform scale.
fn normalMatrix(model: mat4x4f) -> mat3x3f {
    let c0 = model[0].xyz;
    let c1 = model[1].xyz;
    let c2 = model[2].xyz;
    let cofactors = mat3x3f(cross(c1, c2), cross(c2, c0), cross(c0, c1));
    return cofactors * sign(dot(c0, cross(c1, c2)));
}

@vertex
fn sceneModelVertex(in: SceneModelVertexIn, @builtin(instance_index) drawIndex: u32) -> SceneModelVertexOut {
    let draw = sceneModelDraws[drawIndex];
    let worldPosition = draw.model * vec4f(in.position, 1.0);
    var out: SceneModelVertexOut;
    out.position = camera.matrix * worldPosition;
    out.worldPosition = worldPosition.xyz;
    out.worldNormal = normalMatrix(draw.model) * in.normal;
    // The parser hands texture coordinates with the origin at the image's
    // top left (glTF's own, an OBJ's flipped), as WebGPU samples.
    out.uv = in.uv;
    out.groundHeight = dot(worldPosition.xyz - draw.groundSurface.xyz, draw.groundUp.xyz);
    out.baseColor = draw.baseColor;
    out.groundClip[0] = select(1.0, out.groundHeight, kSceneModelClipsBelowGround); // clip-distances
    return out;
}

// The ground hole of a model that cuts into the ground: every vertex
// projected onto the ground plane along the up vector, so the mesh
// rasterises as its outline on the surface, seen by the frame's camera. The
// pipeline writes no colour and no depth, the draw's stencil state raises
// or lowers the ground hole bit.
@vertex
fn sceneModelGroundFootprintVertex(@location(0) position: vec3f, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    let draw = sceneModelDraws[drawIndex];
    let worldPosition = (draw.model * vec4f(position, 1.0)).xyz;
    let height = dot(worldPosition - draw.groundSurface.xyz, draw.groundUp.xyz);
    return camera.matrix * vec4f(worldPosition - draw.groundUp.xyz * height, 1.0);
}

// Depth-only vertex of the shadow map pass: the record's matrix is the
// light's projection-view times the model's, the near plane pancaked as
// the buildings' casters are (the Metal depth clamp).
@vertex
fn sceneModelShadowVertex(@location(0) position: vec3f, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    let clip = sceneModelDraws[drawIndex].model * vec4f(position, 1.0);
    return vec4f(clip.xy, clamp(clip.z, 0.0, clip.w), clip.w);
}

// No analytic lighting model, matching the building extrusion: the base
// colour darkens only where the shadow map says the static sun is occluded.
// Faces away from the sun are occluded by their own mesh in the map and come
// out shadowed like any cast shadow.
@fragment
fn sceneModelFragment(in: SceneModelFragmentIn) -> @location(0) vec4f {
    // Sampled before the discard, in uniform control flow.
    let base = textureSample(baseColorTexture, baseColorSampler, in.uv) * in.baseColor;
    if (kSceneModelClipsBelowGround && in.groundHeight < 0.0) { discard; } // no-clip-distances
    let shadowFactor = sampleShadowFactor(shadow, shadowMap, shadowSampler, in.worldPosition, normalize(in.worldNormal));
    let lit = base.rgb * shadowColorMultiplier(shadow, shadowFactor);
    return vec4f(applyGroundFog(lit, in.worldPosition, buildingFog), 1.0);
}

// The footprint draws write no colour: an empty fragment stage keeps the
// colour target's format in the pipeline while the write mask is empty.
@fragment
fn sceneModelFootprintFragment() {}
