// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: ../../globe/shaders/clip-distances.wgsl ../../ground-fog/shaders/ground-fog.wgsl ../../globe/shaders/globe.wgsl
// The layers of the app's data (ImmersiveMapLayer): zones, lines and points
// lying on the ground, a port of the Swift engine's Layers.metal. Their
// geometry is stored as a map tile's is, in the render units of a chunk tile
// (crates/layer-mesh), and each vertex is projected the ground's own way, on
// the surface the frame draws (kLayerSurface), as the labels painted on the
// map are (surface-label.wgsl):
//
// - the flat map, through the chunk's origin and scale,
// - the resting sphere, the unit earth direction through the composed
//   sphere matrix,
// - the unroll, the sphere-to-plane unroll with its cut.
//
// A zone is its triangles. A line is an instance per segment, a shape of the
// screen as wide as the line in points, with round ends as half octagons:
// two segments that meet are joined by the disc their ends share, and no
// geometry of its own is drawn for a join. A line is solid and is the one
// thing here drawn without blending, and its fragment never discards, so a
// tile-based GPU shades each pixel once however many segments lie on it. A
// point is a disc with a ring round it, a quad on screen. Nothing is written
// to depth. What stands in front of a layer (a building, a model, a tree)
// covers it by the surface mask bit it raised in the stencil. The ground's
// depth hides it only on a layer that asks (hidesBehindTerrain), for which
// its z is one constant depth in the ground's far-plane band, a step behind
// the labels painted on the map, and on the relief the relief's own band, so
// a mountain nearer the camera covers it.
//
// The draw's record (group 1, read at the draw's index): a zone's draw is
// its instance index, a line's and a disc's ride on the vertex index, whose
// base the draw sets to the record times kLayerCornerSlots (the instance
// index is the segment's or the disc's).

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One draw, 80 bytes (layer-render-subsystem.ts): the chunk tile (flat:
/// origin and scale, sphere: GlobeSurfaceTile), the drawable in pixels, the
/// pixels per point and the depth the layer lies at, and 1 in params.x for a
/// layer on the relief's band.
struct LayerDraw {
    tile: vec4f,
    screen: vec4f,
    params: vec4f,
    padding0: vec4f,
    padding1: vec4f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(2) var<uniform> groundFog: GroundFog;
@group(0) @binding(3) var<uniform> globe: GlobeFrame;
@group(1) @binding(0) var<storage, read> draws: array<LayerDraw>;

/// The surface the frame draws: 0 the flat map, 1 the resting sphere, 2 the unroll.
override kLayerSurface: u32 = 0u;

const kLayerTileExtent: f32 = 4096.0;
// The scale the projection applies to the z of everything real
// (RenderCamera.realDepthScale): the flat surface and the unroll divide it
// out and apply the layer's own depth, as the labels painted on the map do.
const kLayerRealDepthScale: f32 = 1.0 - 1536.0 * 3.2e-6;
// The relief's band (tile.wgsl): the raised ground keeps the real geometry's
// depth scale, its band a quarter as deep and two steps behind it.
const kLayerReliefBandScale: f32 = 0.25;
const kLayerReliefGroundBehind: f32 = 2.0 * 3.2e-6;
// A vertex nearer the camera than this in clip w is behind it.
const kLayerNearW: f32 = 1.0e-4;
// The vertex indices a line's or a disc's draw takes a record: its base is the record times this.
const kLayerCornerSlots: u32 = 16u;

/// A point of the surface in clip space, with what the fragment needs.
struct LayerClip {
    position: vec4f,
    worldPosition: vec3f,
    sphereNormal: vec3f,
    // Negative where the surface hides the point: the far side of the
    // sphere, the unroll's cut.
    clearance: f32,
}

fn layerProject(local: vec2f, draw: LayerDraw) -> LayerClip {
    var clip: LayerClip;
    if (kLayerSurface == 0u) {
        let world = vec3f(draw.tile.xy + local * draw.tile.z, 0.0);
        clip.position = camera.matrix * vec4f(world, 1.0);
        if (draw.params.x > 0.5) {
            clip.position.z *= 1.0 + kLayerReliefGroundBehind - (1.0 - draw.screen.w) * kLayerReliefBandScale;
        } else {
            clip.position.z *= draw.screen.w / kLayerRealDepthScale;
        }
        clip.worldPosition = world;
        clip.sphereNormal = vec3f(0.0, 0.0, 1.0);
        clip.clearance = 1.0;
        return clip;
    }
    let localUv = vec2f(local.x, kLayerTileExtent - local.y) / kLayerTileExtent;
    let worldUv = draw.tile.xy + localUv * draw.tile.z;
    let morph = kLayerSurface == 2u;
    let point = globeSurfacePoint(worldUv, draw.tile.w, morph, globe);
    clip.position = globeSurfaceClip(point, morph, camera.matrix, globe);
    clip.worldPosition = point.world;
    clip.sphereNormal = point.normal;
    if (morph) {
        clip.position.z *= draw.screen.w / kLayerRealDepthScale;
        clip.clearance = point.clearance;
    } else {
        clip.position.z = draw.screen.w * clip.position.w;
        // The far side of the planet: a zone's triangles go to back-face
        // culling, but a line's and a point's quads face the camera, so
        // every vertex is cut where the sphere turns away from the eye.
        clip.clearance = dot(normalize(point.normal), normalize(camera.eye - point.world));
    }
    return clip;
}

/// The colour as the ground under it is lit: the globe's sun on the sphere
/// and through the unroll, the ground fog on the plane.
fn layerShade(color: vec3f, worldPosition: vec3f, sphereNormal: vec3f) -> vec3f {
    var rgb = color;
    if (kLayerSurface != 0u) {
        rgb = globeLitColor(rgb, sphereNormal, globe);
    }
    return applyGroundFog(rgb, worldPosition, groundFog);
}

// MARK: Zones

struct LayerFillIn {
    @location(0) position: vec2f,
    @location(1) color: vec4f,
}

struct LayerFillOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) worldPosition: vec3f,
    @location(1) sphereNormal: vec3f,
    @location(2) color: vec4f,
    @location(3) cutClearance: f32, // no-clip-distances
}

struct LayerFillFragmentIn {
    @location(0) worldPosition: vec3f,
    @location(1) sphereNormal: vec3f,
    @location(2) color: vec4f,
    @location(3) cutClearance: f32, // no-clip-distances
}

@vertex
fn layerFillVertex(in: LayerFillIn, @builtin(instance_index) drawIndex: u32) -> LayerFillOut {
    let clip = layerProject(in.position, draws[drawIndex]);
    var out: LayerFillOut;
    out.position = clip.position;
    // The fill keeps the sphere's back-face culling for the far side: the cut is the unroll's alone.
    let clearance = select(clip.clearance, 1.0, kLayerSurface == 1u);
    out.cut[0] = clearance; // clip-distances
    out.cutClearance = clearance; // no-clip-distances
    out.worldPosition = clip.worldPosition;
    out.sphereNormal = clip.sphereNormal;
    out.color = in.color;
    return out;
}

@fragment
fn layerFillFragment(in: LayerFillFragmentIn) -> @location(0) vec4f {
    if (in.cutClearance < 0.0) { discard; } // no-clip-distances
    return vec4f(layerShade(in.color.rgb, in.worldPosition, in.sphereNormal), in.color.a);
}

// MARK: Lines

struct LayerLineIn {
    @location(0) start: vec2f,
    @location(1) end: vec2f,
    @location(2) widthPoints: f32,
    /// The colour's red, green and blue, and in the fourth byte which ends
    /// are round, 1 for the start and 2 for the end: a line is always solid.
    @location(3) color: vec4u,
}

struct LayerLineOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) worldPosition: vec3f,
    @location(1) sphereNormal: vec3f,
    @location(2) color: vec3f,
    @location(3) cutClearance: f32, // no-clip-distances
}

struct LayerLineFragmentIn {
    @location(0) worldPosition: vec3f,
    @location(1) sphereNormal: vec3f,
    @location(2) color: vec3f,
    @location(3) cutClearance: f32, // no-clip-distances
}

@vertex
fn layerLineVertex(in: LayerLineIn, @builtin(vertex_index) vertexIndex: u32) -> LayerLineOut {
    let draw = draws[vertexIndex / kLayerCornerSlots];
    let start = layerProject(in.start, draw);
    let end = layerProject(in.end, draw);
    // An end behind the camera is pulled to just before it along the
    // segment, so the shape's direction on screen stays the segment's.
    var startClip = start.position;
    var endClip = end.position;
    if (startClip.w < kLayerNearW && endClip.w > kLayerNearW) {
        startClip = mix(startClip, endClip, (kLayerNearW - startClip.w) / (endClip.w - startClip.w));
    } else if (endClip.w < kLayerNearW && startClip.w > kLayerNearW) {
        endClip = mix(endClip, startClip, (kLayerNearW - endClip.w) / (startClip.w - endClip.w));
    }
    let halfViewport = draw.screen.xy * 0.5;
    let startScreen = startClip.xy / max(startClip.w, kLayerNearW) * halfViewport;
    let endScreen = endClip.xy / max(endClip.w, kLayerNearW) * halfViewport;
    var direction = endScreen - startScreen;
    let length2 = dot(direction, direction);
    direction = select(vec2f(1.0, 0.0), direction * inverseSqrt(max(length2, 1.0e-30)), length2 > 1.0e-8);
    let normal = vec2f(-direction.y, direction.x);

    // The corners of a segment's shape, the same for every segment (the
    // index buffer joins them into triangles): which end the corner is at,
    // how far it stands from that end along the segment (outward positive)
    // and across it, in half widths. Each end is half an octagon, which
    // stands for a half disc at the widths a line has.
    var corners = array<vec3f, 10>(
        vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, 1.0),
        vec3f(0.0, 0.70710678, -0.70710678), vec3f(0.0, 0.70710678, 0.70710678), vec3f(0.0, 1.0, 0.0),
        vec3f(1.0, 0.0, -1.0), vec3f(1.0, 0.0, 1.0),
        vec3f(1.0, 0.70710678, -0.70710678), vec3f(1.0, 0.70710678, 0.70710678), vec3f(1.0, 1.0, 0.0),
    );
    let corner = corners[min(vertexIndex % kLayerCornerSlots, 9u)];
    let atEnd = corner.x > 0.5;
    let isRound = (in.color.a & select(1u, 2u, atEnd)) != 0u;
    // A round end reaches past the segment's end by the line's half width,
    // and two segments that meet with round ends overlap in a disc, their
    // join. A flat end stops at the segment's end: its corners fall onto the
    // end's edge and its triangles are empty.
    let outward = select(0.0, corner.y, isRound);
    let halfWidthPx = in.widthPoints * draw.screen.z * 0.5;
    let offsetPx = (normal * corner.z + direction * select(-outward, outward, atEnd)) * halfWidthPx;
    var position = select(startClip, endClip, atEnd);
    position = vec4f(position.xy + offsetPx / halfViewport * position.w, position.zw);
    let behind = startClip.w < kLayerNearW && endClip.w < kLayerNearW;
    let clearance = select(select(start.clearance, end.clearance, atEnd), -1.0, behind);

    var out: LayerLineOut;
    out.position = position;
    out.cut[0] = clearance; // clip-distances
    out.cutClearance = clearance; // no-clip-distances
    out.worldPosition = select(start.worldPosition, end.worldPosition, atEnd);
    out.sphereNormal = select(start.sphereNormal, end.sphereNormal, atEnd);
    out.color = vec3f(in.color.rgb) / 255.0;
    return out;
}

/// A line's fragment is whole: the shape is its geometry, with no edge to
/// soften and nothing to discard, and the pipeline does not blend. The
/// discard below is the cut's on a device without clip distances alone.
@fragment
fn layerLineFragment(in: LayerLineFragmentIn) -> @location(0) vec4f {
    if (in.cutClearance < 0.0) { discard; } // no-clip-distances
    return vec4f(layerShade(in.color, in.worldPosition, in.sphereNormal), 1.0);
}

// MARK: Points

struct LayerPointIn {
    @location(0) position: vec2f,
    @location(1) radiusPoints: f32,
    @location(2) strokeWidthPoints: f32,
    @location(3) color: vec4f,
    @location(4) strokeColor: vec4f,
}

struct LayerPointOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) worldPosition: vec3f,
    @location(1) sphereNormal: vec3f,
    @location(2) @interpolate(flat) color: vec4f,
    @location(3) @interpolate(flat) strokeColor: vec4f,
    /// The fragment's offset from the centre, in pixels.
    @location(4) offsetPx: vec2f,
    /// The disc's radius and the ring's width, in pixels.
    @location(5) @interpolate(flat) sizePx: vec2f,
    @location(6) cutClearance: f32, // no-clip-distances
}

struct LayerPointFragmentIn {
    @location(0) worldPosition: vec3f,
    @location(1) sphereNormal: vec3f,
    @location(2) @interpolate(flat) color: vec4f,
    @location(3) @interpolate(flat) strokeColor: vec4f,
    @location(4) offsetPx: vec2f,
    @location(5) @interpolate(flat) sizePx: vec2f,
    @location(6) cutClearance: f32, // no-clip-distances
}

@vertex
fn layerPointVertex(in: LayerPointIn, @builtin(vertex_index) vertexIndex: u32) -> LayerPointOut {
    let draw = draws[vertexIndex / kLayerCornerSlots];
    let centre = layerProject(in.position, draw);
    let radiusPx = in.radiusPoints * draw.screen.z;
    let strokeWidthPx = in.strokeWidthPoints * draw.screen.z;
    let extentPx = radiusPx + strokeWidthPx + 1.0;
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let corner = corners[min(vertexIndex % kLayerCornerSlots, 5u)];
    let clearance = select(centre.clearance, -1.0, centre.position.w < kLayerNearW);

    var out: LayerPointOut;
    out.position = centre.position;
    out.position = vec4f(out.position.xy + corner * extentPx / (draw.screen.xy * 0.5) * out.position.w, out.position.zw);
    out.cut[0] = clearance; // clip-distances
    out.cutClearance = clearance; // no-clip-distances
    out.worldPosition = centre.worldPosition;
    out.sphereNormal = centre.sphereNormal;
    out.color = in.color;
    out.strokeColor = in.strokeColor;
    out.offsetPx = corner * extentPx;
    out.sizePx = vec2f(radiusPx, strokeWidthPx);
    return out;
}

@fragment
fn layerPointFragment(in: LayerPointFragmentIn) -> @location(0) vec4f {
    if (in.cutClearance < 0.0) { discard; } // no-clip-distances
    let distance = length(in.offsetPx);
    let radiusPx = in.sizePx.x;
    let strokeWidthPx = in.sizePx.y;
    // The disc, then the ring outside it, each with a pixel of antialiasing
    // at its edge. Outside the ring the coverage is zero, and so is the
    // alpha: the pipeline blends and writes neither depth nor stencil, so a
    // corner of the quad changes nothing without a discard.
    let inside = saturate(radiusPx + 0.5 - distance);
    let covered = saturate(radiusPx + strokeWidthPx + 0.5 - distance);
    var color = select(in.color, mix(in.strokeColor, in.color, inside), strokeWidthPx > 0.0);
    color.a *= covered;
    return vec4f(layerShade(color.rgb, in.worldPosition, in.sphereNormal), color.a);
}
