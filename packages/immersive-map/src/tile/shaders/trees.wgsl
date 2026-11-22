// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ../../shadows/shaders/shadow.wgsl ../../ground-fog/shaders/ground-fog.wgsl standing-frame.wgsl

// The trees of the flat map, a port of the Swift engine's Trees.metal: the
// tree model (TreeModelContents) drawn once per tree of a tile. A tree is
// turned about its trunk, scaled so the model's height spans the tree's
// height in tile units and stood at its point, all in the tile's space,
// then taken into the world by the tile's matrix as the buildings are.
//
// Their shadows are a soft disc each on the ground under the crown: the
// crown's shadow as a sphere's would fall, its centre moved away from the
// sun by the crown's height and stretched along the sun's azimuth by the
// sun's lowness, multiplied into the ground after the roads with the
// darkening and the tint the shadow map gives every other shadow. No map
// lookup, no caster pass.

// The tile the instances of a draw stand in (a dynamic offset a tile):
// its matrix and what a unit of a tree's height is in the model's metres,
// times the tile's rise.
struct TreeTile {
    modelMatrix: mat4x4f,
    heightScale: f32,
    padding0: f32,
    padding1: f32,
    padding2: f32,
}

@group(1) @binding(0) var<uniform> treeTile: TreeTile;

// The model's 20-byte vertex: the position in metres, the normal, and the
// shading (x how far up its part the point lies, y 1 on the trunk).
// The tree's 16-byte instance of the tile's arena: the point, the height in
// tile units, the turn in the low 16 bits and the tint in the next 8.
struct TreeVertexIn {
    @location(0) position: vec3f,
    @location(1) normal: vec4f,
    @location(2) shading: vec4f,
    @location(3) instancePosition: vec2f,
    @location(4) instanceHeight: f32,
    @location(5) instancePacked: u32,
}

struct TreeVertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPosition: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) color: vec3f,
}

fn treeTurned(point: vec2f, sinTurn: f32, cosTurn: f32) -> vec2f {
    return vec2f(point.x * cosTurn - point.y * sinTurn, point.x * sinTurn + point.y * cosTurn);
}

@vertex
fn treeVertex(in: TreeVertexIn) -> TreeVertexOut {
    let turn = f32(in.instancePacked & 0xFFFFu) / 65535.0 * 6.283185307;
    let tint = f32((in.instancePacked >> 16u) & 0xFFu) / 255.0;
    let sinTurn = sin(turn);
    let cosTurn = cos(turn);
    let scale = in.instanceHeight * treeTile.heightScale;
    let local = in.position * scale;
    let placed = vec3f(treeTurned(local.xy, sinTurn, cosTurn) + in.instancePosition, local.z);
    let worldPosition = treeTile.modelMatrix * vec4f(placed, 1.0);
    let turnedNormal = vec3f(treeTurned(in.normal.xy, sinTurn, cosTurn), in.normal.z);
    let m = treeTile.modelMatrix;
    let normalMatrix = mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz);

    var out: TreeVertexOut;
    out.position = camera.matrix * worldPosition;
    out.worldPosition = worldPosition.xyz;
    out.worldNormal = normalize(normalMatrix * turnedNormal);
    // The palette's colours by the point's part and depth in the crown, the
    // tint a shade darker to a shade lighter, so a wood is not one green.
    let crown = mix(treeFrame.crownShadeColor.rgb, treeFrame.crownColor.rgb, in.shading.x);
    let trunk = treeFrame.trunkColor.rgb * (0.85 + 0.2 * in.shading.x);
    let color = select(crown, trunk, in.shading.y > 0.5);
    out.color = color * (0.86 + 0.28 * tint);
    return out;
}

// A soft directional light over the palette's colours: the sun side a
// little brighter, so the crown reads as a volume and its underside keeps
// its green. No shadow map: the trees are not in it.
@fragment
fn treeFragment(in: TreeVertexOut) -> @location(0) vec4f {
    let normal = normalize(in.worldNormal);
    let diffuse = max(dot(normal, treeFrame.lightDirection.xyz), 0.0);
    let shade = 0.68 + 0.26 * diffuse + 0.06 * saturate(normal.z);
    return vec4f(applyGroundFog(in.color * shade, in.worldPosition, buildingFog), 1.0);
}

struct TreeShadowVertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPosition: vec3f,
    // The disc's own coordinates, the rim at length one.
    @location(1) disc: vec2f,
}

// The shadow disc: one quad per instance, two triangles from the vertex
// index, in the tile's space on the ground. Across the sun's azimuth it is
// the crown's radius, along it the radius over the sun's height, its centre
// where the crown's centre falls.
@vertex
fn treeShadowVertex(@builtin(vertex_index) vertexIndex: u32,
                    @location(3) instancePosition: vec2f,
                    @location(4) instanceHeight: f32) -> TreeShadowVertexOut {
    let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
    let unitsPerMetre = instanceHeight * treeTile.heightScale;
    let radius = treeFrame.crown.x * unitsPerMetre;
    let centreHeight = treeFrame.crown.y * unitsPerMetre;
    let light = treeFrame.lightDirection.xyz;
    // The sun never below a fifth of the sky, so the ellipse stays in bounds.
    let lightZ = max(light.z, 0.2);
    let horizontalLength = length(light.xy);
    let along = select(vec2f(1.0, 0.0), light.xy / horizontalLength, horizontalLength > 1.0e-4);
    let across = vec2f(-along.y, along.x);
    let disc = corners[vertexIndex % 6u];
    let centre = instancePosition - along * (horizontalLength / lightZ) * centreHeight;
    let point = centre + along * (disc.x * radius / lightZ) + across * (disc.y * radius);
    let worldPosition = treeTile.modelMatrix * vec4f(point, 0.0, 1.0);
    var out: TreeShadowVertexOut;
    out.position = camera.matrix * worldPosition;
    out.worldPosition = worldPosition.xyz;
    out.disc = disc;
    return out;
}

// The ground's darkening under the disc: full inside, feathered to nothing
// at the rim, faded with the distance as the shadow map's shadows are, and
// gone into the fog as the ground is. The colour is the multiplier the
// ground takes (the pipeline multiplies it in), the shadow map's own for a
// cast shadow of that coverage.
@fragment
fn treeShadowFragment(in: TreeShadowVertexOut) -> @location(0) vec4f {
    var coverage = 1.0 - smoothstep(0.55, 1.0, length(in.disc));
    coverage *= shadowCascadeBlend(shadow, in.worldPosition.xy).y;
    coverage *= 1.0 - groundFogAmount(in.worldPosition, groundFog);
    let multiplier = shadowColorMultiplier(shadow, 1.0 - coverage * shadow.eyeAndStrength.w);
    return vec4f(multiplier, 1.0);
}
