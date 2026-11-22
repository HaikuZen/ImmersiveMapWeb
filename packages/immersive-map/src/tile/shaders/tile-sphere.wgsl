// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: ../../globe/shaders/clip-distances.wgsl tile-shading.wgsl ../../globe/shaders/globe.wgsl
// The tile geometry of the globe, drawn straight onto the sphere: the same
// vertices, styles, line coverage and fades as the flat surface
// (tile-shading.wgsl). A port of the Swift engine's TileSphere.metal.
//
// One vertex stage, two worlds by the kGlobeMorph override:
// - the resting sphere: the unit earth direction goes through one composed
//   matrix (camera x translate x pan rotation x radius, built on the CPU per
//   frame) straight to clip space, and the far side of the planet is
//   removed by back-face culling alone;
// - the unroll (globe.wgsl), under which the surface never intersects the
//   planet or itself, so it needs no occlusion either, only the cut.
//
// The ground carries no geometric depth of its own: its z is a rank band at
// the far plane, class first, style rank second. Which tile owns a pixel is
// the tile-priority stencil's decision (TileSourceStencilPriority), so the
// rank only orders the layers of one tile: the opaque fills are shaded once
// by their topmost layer, the ribbons pass over every fill.

/// The unroll toward the plane (transition above 0): the unrolled position,
/// the cut. Off on the resting sphere.
override kGlobeMorph: bool = false;
/// The ribbons class: the style index rides flat and the fragment resolves
/// the style with the analytic line coverage. The fills class resolves its
/// colour in the vertex stage.
override kTileLineFields: bool = false;
/// Which part of a ribbon the ribbons class paints: 0 the whole ribbon, 1
/// the core (the fragments the line covers by half or more, writing the
/// rank depth, highest rank first), 2 the feather (the rest, blended over
/// what the cores wrote). A fragment outside its phase is discarded.
override kTileSphereRibbonPhase: i32 = 0;

const kTileSphereExtent: f32 = 4096.0;
// One style rank step at the far plane, and the ribbons' band one class
// nearer than the fills (GlobeSurfaceDepthRank).
const kTileSphereLayerDepthStep: f32 = 3.2e-6;
const kTileSphereRibbonDepthBand: f32 = 257.0 * kTileSphereLayerDepthStep;
const kTileSphereRibbonCoreCoverage: f32 = 0.5;

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One draw, read at the draw's instance index: the tile's place in the
/// world uv (GlobeSurfaceTile) in the record's first row, the dash scale in
/// its last float. The layout is the flat TileDraw's 80 bytes.
struct SphereTileDraw {
    uvOrigin: vec2f,
    uvScale: f32,
    referenceWorldX: f32,
    unused: array<vec4f, 3>,
    depthOffset: f32,
    depthRankStep: f32,
    alphaScale: f32,
    dashUnitsPerPoint: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> overviewFade: OverviewFade;
@group(0) @binding(3) var<uniform> globe: GlobeFrame;
@group(1) @binding(0) var<storage, read> draws: array<SphereTileDraw>;
@group(2) @binding(0) var<storage, read> styles: array<Style>;
@group(2) @binding(1) var<storage, read> styleZoomFades: array<vec2f>;
@group(2) @binding(2) var<storage, read> lineStyles: array<LineStyle>;

struct SphereVertexIn {
    @location(0) position: vec2f,
    @location(1) styleIndex: u32,
    @location(2) lineDistance: i32,
    @location(3) lineParameter: i32,
}

struct SphereVertexOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) sphereNormal: vec3f,
    @location(1) color: vec4f,
    @location(2) @interpolate(flat) styleIndex: u32,
    @location(3) lineDistance: f32,
    @location(4) lineParameterRaw: f32,
    @location(5) @interpolate(flat) drawIndex: u32,
    @location(6) cutClearance: f32, // no-clip-distances
}

// The fragment stage's view of SphereVertexOut, without the clip distances.
struct SphereFragmentIn {
    @builtin(position) position: vec4f,
    @location(0) sphereNormal: vec3f,
    @location(1) color: vec4f,
    @location(2) @interpolate(flat) styleIndex: u32,
    @location(3) lineDistance: f32,
    @location(4) lineParameterRaw: f32,
    @location(5) @interpolate(flat) drawIndex: u32,
    @location(6) cutClearance: f32, // no-clip-distances
}

@vertex
fn tileSphereVertex(in: SphereVertexIn, @builtin(instance_index) drawIndex: u32) -> SphereVertexOut {
    let draw = draws[drawIndex];
    // The parser stores render-space positions (y up), and the world uv runs
    // from the tile's north edge. Not clamped: the stitching margins of line
    // geometry lie beyond the tile on purpose.
    let localUv = vec2f(in.position.x, kTileSphereExtent - in.position.y) / kTileSphereExtent;
    let worldUv = draw.uvOrigin + localUv * draw.uvScale;
    let point = globeSurfacePoint(worldUv, draw.referenceWorldX, kGlobeMorph, globe);
    var out: SphereVertexOut;
    out.position = globeSurfaceClip(point, kGlobeMorph, camera.matrix, globe);
    out.sphereNormal = point.normal;
    var layerNdcZ = 1.0 - (f32(in.styleIndex) + 1.0) * kTileSphereLayerDepthStep;
    if (kTileLineFields) {
        layerNdcZ -= kTileSphereRibbonDepthBand;
    }
    out.position.z = layerNdcZ * out.position.w;
    out.cut[0] = point.clearance; // clip-distances
    out.cutClearance = point.clearance; // no-clip-distances
    out.styleIndex = in.styleIndex;
    out.drawIndex = drawIndex;
    out.lineDistance = f32(in.lineDistance) / 127.0;
    out.lineParameterRaw = f32(in.lineParameter);
    out.color = vec4f(0.0);
    if (!kTileLineFields) {
        // The globe's look of the fill (LineStyle.sphereColor) through the
        // globe's view and the unroll, handed over to the fill's own colour
        // with the air, the zoom fade folded into the alpha.
        let lineStyle = lineStyles[in.styleIndex];
        var color = styles[in.styleIndex].color;
        color = vec4f(mix(vec3f(lineStyle.sphereColorR, lineStyle.sphereColorG, lineStyle.sphereColorB), color.rgb, globe.handover), color.a);
        color.a *= tileStyleFade(styleZoomFades[in.styleIndex], overviewFade.cameraZoom);
        out.color = color;
    }
    return out;
}

/// No shadows on the globe, no textures, no fog: the colour comes from the
/// style and the coverage, under the globe's light.
@fragment
fn tileSphereFragment(in: SphereFragmentIn) -> @location(0) vec4f {
    if (kGlobeMorph && in.cutClearance < 0.0) { discard; } // no-clip-distances
    var color = in.color;
    if (kTileLineFields) {
        let draw = draws[in.drawIndex];
        let lineStyle = lineStyles[in.styleIndex];
        // Every rim on the sphere is baked: no deferred ribbons here.
        color = tileLineFragmentColor(styles[in.styleIndex], styleZoomFades[in.styleIndex], lineStyle,
                                      in.lineDistance, in.lineParameterRaw, overviewFade, draw.dashUnitsPerPoint, 0.0);
        if (kTileSphereRibbonPhase != 0) {
            let coverage = tileLineFragmentCoverage(lineStyle, in.lineDistance, in.lineParameterRaw, overviewFade, draw.dashUnitsPerPoint, 0.0);
            let isCore = coverage >= kTileSphereRibbonCoreCoverage;
            if (isCore != (kTileSphereRibbonPhase == 1)) {
                discard;
            }
        }
        // The globe's look of the stroke (sphereColor, sphereAlpha), handed
        // over to the plane's with the air, unless the style switches its
        // look at a zoom of its own (tileLineZoomLook already did).
        if (!tileLineSwitchesLookByZoom(lineStyle)) {
            let sphereColor = vec3f(lineStyle.sphereColorR, lineStyle.sphereColorG, lineStyle.sphereColorB);
            color = vec4f(mix(sphereColor, color.rgb, globe.handover), color.a * mix(lineStyle.sphereAlpha, 1.0, globe.handover));
        }
    }
    return vec4f(globeLitColor(color.rgb, in.sphereNormal, globe), color.a);
}
