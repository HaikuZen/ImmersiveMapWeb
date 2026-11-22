// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: ../../globe/shaders/clip-distances.wgsl ../../globe/shaders/globe.wgsl ../../ground-fog/shaders/ground-fog.wgsl
// The labels painted on the map (LabelPlacement.surface): glyph quads baked
// as an anchor in the tile's render units and offsets in points, scaled by
// the frame into tile units and projected exactly like the ground they lie
// on. The scale is the map's, floored where the ground is small on screen so
// the text never draws under its point size. A port of the Swift engine's
// SurfaceLabel.metal, three vertex stages, one per surface, each the
// ground's own projection:
//
// - surfaceLabelFlatVertex: the flat map, through the source's origin and
//   scale (tile.wgsl);
// - surfaceLabelSphereVertex: the resting sphere, the unit earth direction
//   through the composed sphere matrix (tile-sphere.wgsl);
// - surfaceLabelMorphVertex: the unroll, the sphere-to-plane unroll with
//   its cut.
//
// The z of every stage is one constant depth in the ground's far-plane band,
// nearer than the ground and the roads (SurfaceLabelDepth), so the text lies
// over the ground while every building and model stays in front of it. A
// label draws twice, its halo first and then its fill, blended and never
// written to depth, so a glyph's halo cannot cover its neighbour's fill.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One draw, read at its instance index (80 bytes): the tile (flat: origin
/// and scale, sphere: GlobeSurfaceTile), the colours with the opacity in
/// alpha, the halo's width in atlas texels, 1 for the halo draw, tile units
/// per point at the map's scale, the halo softness, the drawable in pixels,
/// the pixels per point and the depth the text sits at.
struct SurfaceLabelDraw {
    tile: vec4f,
    fillColor: vec4f,
    strokeColor: vec4f,
    params: vec4f,
    screen: vec4f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(2) var<uniform> groundFog: GroundFog;
@group(0) @binding(3) var<uniform> globe: GlobeFrame;
@group(1) @binding(0) var<storage, read> draws: array<SurfaceLabelDraw>;
@group(2) @binding(0) var atlas: texture_2d<f32>;
@group(2) @binding(1) var atlasSampler: sampler;

struct SurfaceLabelVertexIn {
    /// The label's anchor in tile render units.
    @location(0) anchor: vec2f,
    @location(1) uv: vec2f,
    /// The glyph corner's offset from the anchor in points.
    @location(3) offsetPoints: vec2f,
}

struct SurfaceLabelVertexOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) uv: vec2f,
    // The plane's point, for the ground fog. Unused on the sphere.
    @location(1) worldPosition: vec3f,
    @location(2) @interpolate(flat) drawIndex: u32,
    @location(3) cutClearance: f32, // no-clip-distances
}

struct SurfaceLabelFragmentIn {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) worldPosition: vec3f,
    @location(2) @interpolate(flat) drawIndex: u32,
    @location(3) cutClearance: f32, // no-clip-distances
}

const kSurfaceLabelTileExtent: f32 = 4096.0;
// The camera's near plane in view units: a label whose anchor or probe lies nearer is not measured.
const kSurfaceLabelNearPlane: f32 = 0.01;
// The scale the projection applies to the z of everything real
// (RenderCamera.realDepthScale): the flat surface divides it out and applies
// the label's own depth.
const kSurfaceLabelRealDepthScale: f32 = 1.0 - 1536.0 * 3.2e-6;
const kSurfaceLabelDistanceRange: f32 = 24.0;
// How far the scale probe reaches from the anchor, in points of the map's
// own scale: far enough for the float projection to resolve, short enough
// to stay on the anchor's piece of the surface.
const kSurfaceLabelProbePoints: f32 = 16.0;

/// A point of the surface in clip space, with the clearance its surface cuts it by.
struct SurfaceLabelClip {
    position: vec4f,
    worldPosition: vec3f,
    clearance: f32,
    // The projection's z scaled by the label's depth (the flat surface and
    // the morph), or the label's depth as a band at the far plane (the sphere).
    projectedDepth: bool,
}

fn surfaceLabelWorldUv(local: vec2f, tile: vec4f) -> vec2f {
    let localUv = vec2f(local.x, kSurfaceLabelTileExtent - local.y) / kSurfaceLabelTileExtent;
    return tile.xy + localUv * tile.z;
}

fn surfaceLabelFlatClip(local: vec2f, draw: SurfaceLabelDraw) -> SurfaceLabelClip {
    let world = vec3f(draw.tile.xy + local * draw.tile.z, 0.0);
    var clip: SurfaceLabelClip;
    clip.position = camera.matrix * vec4f(world, 1.0);
    clip.worldPosition = world;
    clip.clearance = 1.0;
    clip.projectedDepth = true;
    return clip;
}

fn surfaceLabelSphereClip(local: vec2f, draw: SurfaceLabelDraw) -> SurfaceLabelClip {
    let point = globeSurfacePoint(surfaceLabelWorldUv(local, draw.tile), draw.tile.w, false, globe);
    var clip: SurfaceLabelClip;
    clip.position = globeSurfaceClip(point, false, camera.matrix, globe);
    clip.worldPosition = vec3f(0.0);
    // The far side of the planet goes to back-face culling, as the ground's does.
    clip.clearance = 1.0;
    clip.projectedDepth = false;
    return clip;
}

fn surfaceLabelMorphClip(local: vec2f, draw: SurfaceLabelDraw) -> SurfaceLabelClip {
    let point = globeSurfacePoint(surfaceLabelWorldUv(local, draw.tile), draw.tile.w, true, globe);
    var clip: SurfaceLabelClip;
    clip.position = globeSurfaceClip(point, true, camera.matrix, globe);
    clip.worldPosition = point.world;
    clip.clearance = point.clearance;
    clip.projectedDepth = true;
    return clip;
}

/// Screen pixels per tile unit around the anchor: the longer of the two
/// axes, so a tilt that foreshortens one does not count as a small ground.
/// Zero when the anchor or a probe is behind the camera.
fn surfaceLabelPixelsPerUnit(anchorClip: vec4f, alongX: vec4f, alongY: vec4f, probeUnits: f32, draw: SurfaceLabelDraw) -> f32 {
    if (anchorClip.w <= kSurfaceLabelNearPlane || alongX.w <= kSurfaceLabelNearPlane || alongY.w <= kSurfaceLabelNearPlane) {
        return 0.0;
    }
    let anchorScreen = anchorClip.xy / anchorClip.w;
    let halfViewport = draw.screen.xy * 0.5;
    let spanX = length((alongX.xy / alongX.w - anchorScreen) * halfViewport);
    let spanY = length((alongY.xy / alongY.w - anchorScreen) * halfViewport);
    return max(spanX, spanY) / probeUnits;
}

/// Tile units per point of the text at this frame: the map's own scale, but
/// never smaller on screen than the style's point size. Every vertex of a
/// label measures at the same anchor, so the label scales whole.
fn surfaceLabelUnitsPerPoint(pixelsPerUnit: f32, draw: SurfaceLabelDraw) -> f32 {
    if (pixelsPerUnit <= 0.0) {
        return draw.params.z;
    }
    return max(draw.params.z, draw.screen.z / pixelsPerUnit);
}

fn surfaceLabelOutput(clip: SurfaceLabelClip, uv: vec2f, draw: SurfaceLabelDraw, drawIndex: u32) -> SurfaceLabelVertexOut {
    var out: SurfaceLabelVertexOut;
    out.position = clip.position;
    out.position.z = select(draw.screen.w * clip.position.w, clip.position.z * (draw.screen.w / kSurfaceLabelRealDepthScale), clip.projectedDepth);
    out.uv = uv;
    out.worldPosition = clip.worldPosition;
    out.drawIndex = drawIndex;
    out.cut[0] = clip.clearance; // clip-distances
    out.cutClearance = clip.clearance; // no-clip-distances
    return out;
}

@vertex
fn surfaceLabelFlatVertex(in: SurfaceLabelVertexIn, @builtin(instance_index) drawIndex: u32) -> SurfaceLabelVertexOut {
    let draw = draws[drawIndex];
    let probeUnits = draw.params.z * kSurfaceLabelProbePoints;
    let pixelsPerUnit = surfaceLabelPixelsPerUnit(surfaceLabelFlatClip(in.anchor, draw).position,
                                                  surfaceLabelFlatClip(in.anchor + vec2f(probeUnits, 0.0), draw).position,
                                                  surfaceLabelFlatClip(in.anchor + vec2f(0.0, probeUnits), draw).position,
                                                  probeUnits, draw);
    let local = in.anchor + in.offsetPoints * surfaceLabelUnitsPerPoint(pixelsPerUnit, draw);
    return surfaceLabelOutput(surfaceLabelFlatClip(local, draw), in.uv, draw, drawIndex);
}

@vertex
fn surfaceLabelSphereVertex(in: SurfaceLabelVertexIn, @builtin(instance_index) drawIndex: u32) -> SurfaceLabelVertexOut {
    let draw = draws[drawIndex];
    let probeUnits = draw.params.z * kSurfaceLabelProbePoints;
    let pixelsPerUnit = surfaceLabelPixelsPerUnit(surfaceLabelSphereClip(in.anchor, draw).position,
                                                  surfaceLabelSphereClip(in.anchor + vec2f(probeUnits, 0.0), draw).position,
                                                  surfaceLabelSphereClip(in.anchor + vec2f(0.0, probeUnits), draw).position,
                                                  probeUnits, draw);
    let local = in.anchor + in.offsetPoints * surfaceLabelUnitsPerPoint(pixelsPerUnit, draw);
    return surfaceLabelOutput(surfaceLabelSphereClip(local, draw), in.uv, draw, drawIndex);
}

@vertex
fn surfaceLabelMorphVertex(in: SurfaceLabelVertexIn, @builtin(instance_index) drawIndex: u32) -> SurfaceLabelVertexOut {
    let draw = draws[drawIndex];
    let probeUnits = draw.params.z * kSurfaceLabelProbePoints;
    let pixelsPerUnit = surfaceLabelPixelsPerUnit(surfaceLabelMorphClip(in.anchor, draw).position,
                                                  surfaceLabelMorphClip(in.anchor + vec2f(probeUnits, 0.0), draw).position,
                                                  surfaceLabelMorphClip(in.anchor + vec2f(0.0, probeUnits), draw).position,
                                                  probeUnits, draw);
    let local = in.anchor + in.offsetPoints * surfaceLabelUnitsPerPoint(pixelsPerUnit, draw);
    return surfaceLabelOutput(surfaceLabelMorphClip(local, draw), in.uv, draw, drawIndex);
}

/// The glyph's distance fields in screen pixels. The pixel range comes from
/// the uv derivatives, so it follows the glyph's size on screen through the
/// perspective and the zoom.
@fragment
fn surfaceLabelFragment(in: SurfaceLabelFragmentIn) -> @location(0) vec4f {
    let texel = textureSample(atlas, atlasSampler, in.uv);
    let screenTextureSize = 1.0 / max(fwidth(in.uv), vec2f(1e-6));
    if (in.cutClearance < 0.0) { discard; } // no-clip-distances
    let draw = draws[in.drawIndex];
    let msdfDistance = max(min(texel.r, texel.g), min(max(texel.r, texel.g), texel.b)) - 0.5;
    let sdfDistance = texel.a - 0.5;
    let unitRange = vec2f(kSurfaceLabelDistanceRange) / vec2f(textureDimensions(atlas));
    let screenPxRange = max(0.5 * dot(unitRange, screenTextureSize), 1.0);
    // Screen pixels per atlas texel.
    let pixelsPerTexel = screenPxRange / kSurfaceLabelDistanceRange;
    var coverage: f32;
    var color: vec3f;
    var opacity: f32;
    if (draw.params.y > 0.5) {
        // The halo reaches past the glyph by its width, bounded by the field's support.
        let haloPx = min(draw.params.x * pixelsPerTexel, max(0.5 * screenPxRange - 0.5, 0.0));
        if (haloPx <= 0.0) {
            discard;
        }
        // The halo ends where it always did and fades in from there, as a screen label's does.
        let fadePx = haloPx * draw.params.w;
        coverage = smoothstep(-haloPx - 0.5, -haloPx + 0.5 + fadePx, sdfDistance * screenPxRange);
        color = draw.strokeColor.rgb;
        opacity = draw.strokeColor.a;
    } else {
        // The point labels' weight bias, so a name reads the same on the map as on the screen.
        let boldBiasPx = 0.75;
        coverage = smoothstep(-0.5, 0.5, msdfDistance * screenPxRange + boldBiasPx);
        color = draw.fillColor.rgb;
        opacity = draw.fillColor.a;
    }
    let alpha = coverage * opacity;
    if (alpha <= 0.0) {
        discard;
    }
    return vec4f(applyGroundFog(color, in.worldPosition, groundFog), alpha);
}
