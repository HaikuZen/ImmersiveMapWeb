// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: tile-shading.wgsl ../../ground-fog/shaders/ground-fog.wgsl ../../shadows/shaders/shadow.wgsl ../../shadows/shaders/ground-shadow-receiver.wgsl ../relief/shaders/ground-relief.wgsl
// The flat map's tile geometry: the ground fills, the ground's line ribbons,
// the road buckets and the bridge overlay. A port of the Swift engine's
// Tile.metal. Prepended with tile-shading.wgsl.
//
// The Metal function constants are override constants here, so each pipeline
// variant compiles only what it draws. Every ground fragment is darkened
// by the ground shadow mask (ground-shadow-receiver.wgsl), or on the relief
// by the shadow map's windows at its raised point, and fogged.

/// The pass carries the analytic line fields (the ribbons class, the road
/// buckets and the bridge overlay). The fills classes carry a resolved colour.
override kTileLineFields: bool = false;
/// The road ribbons: deferred (the centreline and a direction, extruded here),
/// hard-edged, ordered by their rank depth.
override kTileRoadRibbons: bool = false;
/// The road ribbons that are not opaque this frame: blended, the gaps of a
/// dashed style discarded.
override kTileRoadBlended: bool = false;
/// The flattened ground raised by a heightmap (GroundReliefStore): the
/// vertex rises by the terrain's height under it, read from the relief's
/// texture (ground-relief.wgsl). The fills on the relief shade their slopes
/// (groundReliefHillshade) and darken where the terrain hides the sky.
override kTileGroundRelief: bool = false;
/// How far the relief's line primitives (the roads' edge lines) are pulled
/// toward the eye, a share of the clip w: WebGPU gives a line no depth bias,
/// which the relief's other classes over the ground draw with.
override kTileReliefLineDepthPull: f32 = 0.0;

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One draw, read at the draw's instance index (its firstInstance): the tile's model matrix and its place in the rank-depth band
/// (the group's offset, and the step from one style rank to the next, 0 for a
/// flattened ground whose fills overlap nowhere).
struct TileDraw {
    model: mat4x4f,
    depthOffset: f32,
    depthRankStep: f32,
    // The road edge lines draw at a share of the road's alpha.
    alphaScale: f32,
    // Tile units per layout point at the source tile's nominal display scale:
    // the dash pattern stays anchored to the geometry (the Swift LineDashUniform).
    dashUnitsPerPoint: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> overviewFade: OverviewFade;
@group(0) @binding(2) var<uniform> groundFog: GroundFog;
@group(1) @binding(0) var<storage, read> draws: array<TileDraw>;
@group(2) @binding(0) var<storage, read> styles: array<Style>;
@group(2) @binding(1) var<storage, read> styleZoomFades: array<vec2f>;
@group(2) @binding(2) var<storage, read> lineStyles: array<LineStyle>;

// The flat rank-depth step, one value with the sphere's.
const kFlatTileLayerDepthStep: f32 = 3.2e-6;
// The camera's near plane in view units (RenderCamera.nearPlane).
const kFlatCameraNearPlane: f32 = 0.01;
// The scale the camera's projection applies to the z of everything real: the
// ground divides it out and applies its own layer's scale.
const kFlatRealDepthScale: f32 = 1.0 - 1536.0 * kFlatTileLayerDepthStep;
// The farthest a deferred ribbon's vertex moves, in tile units.
const kTileDeferredRibbonMaximumUnits: f32 = 1024.0;
// The narrowest a road ribbon is extruded, in pixels from the centreline.
const kTileRoadMinimumHalfWidthPx: f32 = 0.5;
// The style ranks of one road band: a style past the last shares it.
const kTileRoadBandRanks: f32 = 12.0;
// The ground relief's depth (kTileGroundRelief): a hill has to hide the
// buildings behind it, so a flattened tile raised by its terrain keeps the
// real geometry's depth scale, which the camera applied (kFlatRealDepthScale
// is not divided out), and its band shrinks to a quarter and sits two steps
// behind the real geometry: the ground loses to a wall's base at its own
// depth as before, the roads and the lines over it keep their order among
// themselves. The pipelines give the roads and the lines over such a ground
// a slope-scaled depth bias, which keeps them over it where their triangles
// sample the terrain apart from the ground's.
const kReliefBandScale: f32 = 0.25;
const kReliefGroundBehind: f32 = 2.0 * kFlatTileLayerDepthStep;

struct VertexIn {
    @location(0) position: vec2f,
    @location(1) styleIndex: u32,
    @location(2) lineDistance: i32,
    @location(3) lineParameter: i32,
    @location(4) normal: vec2f,
}

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) color: vec4f,
    @location(2) @interpolate(flat) styleIndex: u32,
    @location(3) lineDistance: f32,
    @location(4) lineParameterRaw: f32,
    @location(5) @interpolate(flat) deferredEdgePx: f32,
    @location(6) widthAxis: vec2f,
    @location(7) @interpolate(flat) drawIndex: u32,
    // Where the point lies in the terrain its slopes are shaded by (the relief's fills).
    @location(8) reliefUV: vec2f,
}

@vertex
fn tileVertex(in: VertexIn, @builtin(instance_index) drawIndex: u32) -> VertexOut {
    let draw = draws[drawIndex];
    var localPosition = in.position;
    var deferredEdgePx = 0.0;
    var widthAxis = vec2f(0.0);
    let model = draw.model;
    if (kTileLineFields) {
        // A deferred ribbon: the vertex is a point of the centreline and
        // carries the direction to extrude along, by the style's width
        // resolved in pixels right here.
        var normal = in.normal;
        if (dot(normal, normal) > 0.25) {
            normal = normalize(normal);
            widthAxis = normal;
            let lineStyle = lineStyles[in.styleIndex];
            let clipCentre = camera.matrix * (model * vec4f(localPosition, 0.0, 1.0));
            let clipAlong = camera.matrix * (model * vec4f(normal, 0.0, 0.0));
            let w0 = max(clipCentre.w, kFlatCameraNearPlane);
            let w1 = max(clipCentre.w + clipAlong.w, kFlatCameraNearPlane);
            let screenSpan = ((clipCentre.xy + clipAlong.xy) / w1 - clipCentre.xy / w0) * overviewFade.viewportSizePx * 0.5;
            let pixelsPerUnit = max(length(screenSpan), 1e-4);
            deferredEdgePx = tileLineEdgePixels(lineStyle, pixelsPerUnit, overviewFade.pixelsPerPoint, overviewFade.cameraZoom);
            var isotropicPixelsPerUnit = pixelsPerUnit;
            let modelScale = max(length(model[0].xyz), 1e-9);
            let groundWidths = overviewFade.pointWidthReferenceDepth > 0.0 && overviewFade.pointWidthCentrePixelsPerWorldUnit > 0.0;
            if (groundWidths) {
                isotropicPixelsPerUnit = max(overviewFade.pointWidthCentrePixelsPerWorldUnit * overviewFade.pointWidthReferenceDepth / w0 * modelScale, 1e-4);
            }
            var units: f32;
            if (lineStyle.widthPoints > 0.0 && groundWidths) {
                // A point-locked width lies on the ground: one ground half-width
                // per style, stated directly in tile units.
                units = deferredEdgePx / overviewFade.pointWidthCentrePixelsPerWorldUnit / modelScale;
            } else {
                var rimEdgePx = deferredEdgePx;
                if (lineStyle.widthPoints > 0.0) {
                    rimEdgePx *= tilePointWidthPerspectiveScale(overviewFade, w0, normal, clipCentre.xy / w0);
                }
                units = rimEdgePx / pixelsPerUnit;
            }
            if (kTileRoadRibbons) {
                units = max(units, kTileRoadMinimumHalfWidthPx / isotropicPixelsPerUnit);
            } else {
                units += kTileDeferredRibbonFeatherPx / isotropicPixelsPerUnit;
            }
            units = min(units, kTileDeferredRibbonMaximumUnits);
            localPosition += normal * units;
        }
    }
    var worldPosition = model * vec4f(localPosition, 0.0, 1.0);
    if (kTileGroundRelief) {
        worldPosition.z += groundReliefLift(localPosition);
    }
    var out: VertexOut;
    out.position = camera.matrix * worldPosition;
    // The flat surface lies on one plane: its depth is the projection's z of
    // that plane scaled by the layer's rank, under the real geometry's scale.
    var styleRank = f32(in.styleIndex);
    if (kTileRoadRibbons) {
        styleRank = min(styleRank, kTileRoadBandRanks - 1.0);
    }
    let layerDepthScale = 1.0 - draw.depthOffset - styleRank * draw.depthRankStep - kFlatTileLayerDepthStep;
    if (kTileGroundRelief) {
        out.position.z *= 1.0 + kReliefGroundBehind - (1.0 - layerDepthScale) * kReliefBandScale;
        out.position.z -= kTileReliefLineDepthPull * out.position.w;
        out.reliefUV = groundReliefShadingUV(localPosition);
    } else {
        out.position.z *= layerDepthScale / kFlatRealDepthScale;
        out.reliefUV = vec2f(0.0);
    }
    out.worldPos = worldPosition.xyz;
    out.styleIndex = in.styleIndex;
    out.lineParameterRaw = f32(in.lineParameter);
    out.lineDistance = f32(in.lineDistance) / 127.0;
    out.deferredEdgePx = deferredEdgePx;
    out.widthAxis = widthAxis;
    out.drawIndex = drawIndex;
    out.color = vec4f(0.0);
    if (kTileRoadRibbons) {
        // The road's colour is final here: the style's, with its fade and ramp alpha.
        var color = tileLineZoomLook(lineStyles[in.styleIndex], styles[in.styleIndex].color, overviewFade.cameraZoom);
        color.a *= tileStyleFade(styleZoomFades[in.styleIndex], overviewFade.cameraZoom);
        color.a *= tilePointWidthRampAlpha(lineStyles[in.styleIndex], overviewFade.cameraZoom);
        out.color = color;
        // A road invisible this frame is cut whole: every vertex of its
        // polygons shares its style, so pushing them out of the clip volume
        // drops its triangles (the Swift clip distance).
        if (color.a <= 0.0) {
            out.position = vec4f(0.0, 0.0, -2.0, 1.0);
        }
    } else if (!kTileLineFields) {
        // The fills fold the zoom fade into the colour here.
        var color = styles[in.styleIndex].color;
        color.a *= tileStyleFade(styleZoomFades[in.styleIndex], overviewFade.cameraZoom);
        out.color = color;
    }
    return out;
}

/// The point-locked width of a deferred ribbon at this pixel's depth.
/// `position.w` is one over the view depth.
fn tileFragmentDeferredEdgePx(in: VertexOut) -> f32 {
    var deferredEdgePx = in.deferredEdgePx;
    if (deferredEdgePx > 0.0 && lineStyles[in.styleIndex].widthPoints > 0.0) {
        let ndc = in.position.xy / max(overviewFade.viewportSizePx, vec2f(1.0)) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
        deferredEdgePx *= tilePointWidthPerspectiveScale(overviewFade, 1.0 / max(in.position.w, 1e-6), in.widthAxis, ndc);
    }
    return deferredEdgePx;
}

/// The fills and the ribbons. Nothing discards: a retained substitute is kept
/// out of covered slots by the tile-priority stencil test.
fn tileFragmentColor(in: VertexOut) -> vec4f {
    let draw = draws[in.drawIndex];
    if (kTileLineFields) {
        let edgePx = tileFragmentDeferredEdgePx(in);
        return tileLineFragmentColor(styles[in.styleIndex], styleZoomFades[in.styleIndex], lineStyles[in.styleIndex],
                                     in.lineDistance, in.lineParameterRaw, overviewFade, draw.dashUnitsPerPoint, edgePx);
    }
    return in.color;
}

/// The shadow over a ground fragment: the plane's mask at its pixel, or on
/// the relief the shadow map's windows at the raised point itself (the mask
/// is the plane's shadow).
fn tileShadowMultiplier(in: VertexOut) -> vec3f {
    if (kTileGroundRelief) {
        return tileReliefShadowMultiplier(in.worldPos);
    }
    return tileGroundShadowMultiplier(in.position);
}

@fragment
fn tileFragment(in: VertexOut) -> @location(0) vec4f {
    let color = tileFragmentColor(in);
    var rgb = color.rgb;
    if (kTileGroundRelief && !kTileLineFields) {
        rgb = groundReliefHillshade(rgb, in.reliefUV, in.worldPos);
        rgb = groundReliefOcclude(rgb, in.reliefUV);
    }
    let shaded = rgb * tileShadowMultiplier(in);
    return vec4f(applyGroundFog(shaded, in.worldPos, groundFog), color.a);
}

/// The road ribbons: the geometry is the road, so there is no coverage. Which
/// road owns a pixel is the depth test's work, over the rank the vertex wrote.
@fragment
fn tileRoadFragment(in: VertexOut) -> @location(0) vec4f {
    let draw = draws[in.drawIndex];
    var color = in.color;
    if (kTileRoadBlended) {
        color.a *= draw.alphaScale;
        // The derivative before the discard: fwidth needs the whole quad.
        let parameterSpan = fwidth(in.lineParameterRaw);
        let lineStyle = lineStyles[in.styleIndex];
        if (lineStyle.dashLengthPoints > 0.0 && parameterSpan > 2e-5) {
            let unitScale = select(draw.dashUnitsPerPoint, 1.0, lineStyle.dashInTileUnits > 0.0);
            let dashUnits = lineStyle.dashLengthPoints * unitScale;
            let gapUnits = lineStyle.dashGapPoints * unitScale;
            if (dashUnits > 0.0 && gapUnits > 0.0 && tileDashEdgeDistance(in.lineParameterRaw * 0.5, dashUnits, dashUnits + gapUnits) < 0.0) {
                discard;
            }
        }
    } else {
        color.a = 1.0;
    }
    let shaded = color.rgb * tileShadowMultiplier(in);
    return vec4f(applyGroundFog(shaded, in.worldPos, groundFog), color.a);
}
