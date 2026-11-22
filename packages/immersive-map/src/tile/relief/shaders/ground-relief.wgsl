// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// library
// The ground relief as the vertex stages read it, a port of the Swift
// engine's GroundRelief.h: the vector ground (tile.wgsl, kTileGroundRelief)
// and the raster ground (tile-raster.wgsl, kTileRasterRelief) rise by the
// same sample of the same terrain, scaled by the same strength, and their
// fills' fragment stages shade the slopes of the same terrain
// (groundReliefHillshade). The bindings are the relief's group
// (GroundReliefGpu.layout), group 3 of the tile pipelines.

// Where a tile lies in its terrain texture, how high its terrain draws this
// frame and how its slopes are shaded (GroundReliefUniform, 144 bytes):
// - placement: the tile's north-west corner and side in the terrain
//   texture's 0 to 1, and the world units a metre of terrain rises by, the
//   frame's for every tile, the exaggeration not in it.
// - frame: the datum, the terrain's metres under the point the camera looks
//   at, which the ground is drawn from, the strength, and the ground metres
//   the shading's terrain texture spans a side.
// - hillshadeLight: the direction toward the scene's light in the flat
//   basis (+x east, +y north, +z up), unit length, and the amount of
//   shading, zero for none.
// - hillshadeShadowColor, hillshadeHighlightColor: the colours a slope
//   turned away from the light and toward it are drawn toward, the alpha
//   capping how far.
// - hillshadeEye: the eye in the world, which the fade is measured from.
// - hillshadeFade: the world distance from the eye the shading starts to
//   fade at, and one over the distance it takes to fade out.
// - shading: the tile's north-west corner and side in the terrain texture
//   its slopes are shaded by (reliefShadingHeights), the ring's terrain,
//   finer than the one the grid rises by where the ring reads finer terrain
//   than the displacement's zoom; frame.z spans it.
// - occlusion: how dark a point the terrain hides the sky from entirely is
//   drawn (x, 0 for none), and whether the occlusion is drawn alone in grey
//   (y, the debug view). The occlusion itself is reliefOcclusion, one texel
//   of none while it is not computed.
struct GroundReliefUniform {
    placement: vec4f,
    frame: vec4f,
    hillshadeLight: vec4f,
    hillshadeShadowColor: vec4f,
    hillshadeHighlightColor: vec4f,
    hillshadeEye: vec4f,
    hillshadeFade: vec4f,
    shading: vec4f,
    occlusion: vec4f,
}

@group(3) @binding(0) var<uniform> relief: GroundReliefUniform;
// The terrain the grid rises by (PlaceTile.displacement), read by the vertex stage.
@group(3) @binding(1) var reliefHeights: texture_2d<f32>;
// The terrain the slopes are shaded by (PlaceTile.terrain), read by the fills' fragment stage.
@group(3) @binding(2) var reliefShadingHeights: texture_2d<f32>;
// The shading terrain's occlusion of the sky (GroundReliefOcclusion).
@group(3) @binding(3) var reliefOcclusion: texture_2d<f32>;
// Linear, clamped to the edge.
@group(3) @binding(4) var reliefSampler: sampler;

// The texture's uv of a tile-local point: the point is render space (y up),
// the texture's row 0 is the north edge.
fn groundReliefTileUV(localPosition: vec2f) -> vec2f {
    return saturate(vec2f(localPosition.x, 4096.0 - localPosition.y) / 4096.0);
}

// Where a tile-local point lies in the terrain texture the grid rises by.
fn groundReliefTextureUV(localPosition: vec2f) -> vec2f {
    return relief.placement.xy + groundReliefTileUV(localPosition) * relief.placement.z;
}

// Where a tile-local point lies in the terrain texture the slopes are shaded by.
fn groundReliefShadingUV(localPosition: vec2f) -> vec2f {
    return relief.shading.xy + groundReliefTileUV(localPosition) * relief.shading.z;
}

// The terrain's height in metres under a tile-local point: one bilinear
// sample of the half-float texture.
fn groundReliefHeight(localPosition: vec2f) -> f32 {
    return textureSampleLevel(reliefHeights, reliefSampler, groundReliefTextureUV(localPosition), 0.0).r;
}

// The world z a tile-local point rises to over the plane: its terrain's
// height over the datum, in world units, at the frame's strength.
fn groundReliefLift(localPosition: vec2f) -> f32 {
    let metres = groundReliefHeight(localPosition) - relief.frame.x;
    return metres * relief.frame.y * relief.placement.w;
}

// A colour of the ground with its slope shaded at a point of the shading's
// terrain texture (textureUV, groundReliefShadingUV): the slope is the
// terrain's own, the heights a texel to each side, as fine as the ring's
// terrain. Level ground keeps its colour. A slope turned toward the light is
// drawn toward the highlight, up to all the way for a slope that faces the
// light square on, and one turned away toward the shadow, up to all the way
// for a slope the light only grazes. The slope is the terrain's true one, not
// the relief's exaggeration. The shading fades out with the distance of the
// point from the eye, and past the fade the terrain is not read.
fn groundReliefHillshade(color: vec3f, textureUV: vec2f, worldPosition: vec3f) -> vec3f {
    let faded = saturate((distance(worldPosition, relief.hillshadeEye.xyz) - relief.hillshadeFade.x) * relief.hillshadeFade.y);
    let amount = relief.hillshadeLight.w * (1.0 - faded * faded * (3.0 - 2.0 * faded));
    if (amount <= 0.0) {
        return color;
    }
    let texel = 1.0 / vec2f(textureDimensions(reliefShadingHeights));
    let east = textureSampleLevel(reliefShadingHeights, reliefSampler, textureUV + vec2f(texel.x, 0.0), 0.0).r
        - textureSampleLevel(reliefShadingHeights, reliefSampler, textureUV - vec2f(texel.x, 0.0), 0.0).r;
    // The texture's rows run south.
    let north = textureSampleLevel(reliefShadingHeights, reliefSampler, textureUV - vec2f(0.0, texel.y), 0.0).r
        - textureSampleLevel(reliefShadingHeights, reliefSampler, textureUV + vec2f(0.0, texel.y), 0.0).r;
    let span = 2.0 * texel * max(relief.frame.z, 1e-3);
    let normal = normalize(vec3f(-east / span.x, -north / span.y, 1.0));
    let light = relief.hillshadeLight.xyz;
    // Zero on level ground, one for a slope square to the light, minus one
    // for one the light grazes.
    let facing = dot(normal, light) - light.z;
    let lit = select(facing / max(light.z, 1e-3), facing / max(1.0 - light.z, 1e-3), facing >= 0.0);
    let tint = select(relief.hillshadeShadowColor, relief.hillshadeHighlightColor, lit >= 0.0);
    let share = saturate(abs(lit) * amount) * tint.a;
    return mix(color, tint.rgb, share);
}

// A colour of the ground darkened by how much the terrain around the point
// hides the sky (GroundReliefOcclusion): the occlusion sampled at a point of
// the shading's terrain texture takes the colour toward black by the frame's
// strength. The debug view draws the occlusion alone: white for the open
// sky, black for none.
fn groundReliefOcclude(color: vec3f, textureUV: vec2f) -> vec3f {
    if (relief.occlusion.x <= 0.0 && relief.occlusion.y <= 0.0) {
        return color;
    }
    let occluded = textureSampleLevel(reliefOcclusion, reliefSampler, textureUV, 0.0).r;
    if (relief.occlusion.y > 0.0) {
        let lit = 1.0 - occluded;
        return vec3f(lit);
    }
    return color * (1.0 - relief.occlusion.x * occluded);
}
