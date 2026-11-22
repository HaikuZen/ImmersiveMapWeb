// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// library
// Everything the flat tile shader (tile.wgsl) and the sphere tile shader
// share: the per-style tables, the analytic line coverage, the zoom fade and
// the point-width ramps. A port of the Swift engine's TileShading.h. One
// copy, so the two surfaces cannot drift apart in how a style is drawn.

/// The Swift `TilePolygonStyle`: one colour per style.
struct Style {
    color: vec4f,
}

/// The Swift `TileLineStyle`, 68 bytes, indexed per style alongside `Style`.
/// Every member is a scalar so the array stride is 68 as on the CPU side.
struct LineStyle {
    widthPoints: f32,
    dashLengthPoints: f32,
    dashGapPoints: f32,
    edgeThreshold: f32,
    minimumWidthPoints: f32,
    // Non-zero: the dash is in tile units, cut from the arc length without
    // the point-to-unit conversion (world-locked paint such as a lane divider).
    dashInTileUnits: f32,
    // The styled half-width in tile units, for the deferred extrusion.
    halfWidthUnits: f32,
    // The camera zoom a point-locked width is frozen on the ground from (0: never).
    worldLockZoom: f32,
    // The zoom ramp of a point-locked width (an end zoom of 0: no ramp).
    rampStartWidthPoints: f32,
    rampStartZoom: f32,
    rampEndZoom: f32,
    rampStartAlpha: f32,
    // The share of the colour's alpha the stroke keeps on the globe, and the
    // colour it wears there.
    sphereAlpha: f32,
    sphereColorR: f32,
    sphereColorG: f32,
    sphereColorB: f32,
    // The camera zoom the stroke keeps its sphere look up to (0: none).
    sphereLookUntilZoom: f32,
}

/// Per frame: what every tile draw reads besides its own tables.
struct OverviewFade {
    pixelsPerPoint: f32,
    // The camera's planning zoom: every style's fade and width ramp answers it.
    cameraZoom: f32,
    // The drawable in pixels.
    viewportSizePx: vec2f,
    // The view depth of the ground point at the centre of the screen (0: the
    // widths hold in pixels at every depth).
    pointWidthReferenceDepth: f32,
    // The pixels one world unit of ground spans across the view at the centre.
    pointWidthCentrePixelsPerWorldUnit: f32,
    // The camera matrix's columns of the two ground axes, x, y and w rows.
    groundAxisXClip: vec3f,
    groundAxisYClip: vec3f,
}

const kTileDeferredRibbonFeatherPx: f32 = 1.0;

fn tileLineSwitchesLookByZoom(s: LineStyle) -> bool {
    return s.sphereLookUntilZoom > 0.0;
}

/// A stroke's colour and alpha at the camera zoom: its globe look below its
/// switch zoom, its own from it.
fn tileLineZoomLook(s: LineStyle, own: vec4f, cameraZoom: f32) -> vec4f {
    if (tileLineSwitchesLookByZoom(s) && cameraZoom < s.sphereLookUntilZoom) {
        return vec4f(s.sphereColorR, s.sphereColorG, s.sphereColorB, own.a * s.sphereAlpha);
    }
    return own;
}

fn tilePointWidthRampProgress(s: LineStyle, cameraZoom: f32) -> f32 {
    if (s.rampEndZoom <= s.rampStartZoom) {
        return 1.0;
    }
    return clamp((cameraZoom - s.rampStartZoom) / (s.rampEndZoom - s.rampStartZoom), 0.0, 1.0);
}

/// The point-locked width at a camera zoom: the ramp runs in ratios, the same
/// growth per zoom level, so nothing steps when the serving tile level changes.
fn tilePointWidthPoints(s: LineStyle, cameraZoom: f32) -> f32 {
    let progress = tilePointWidthRampProgress(s, cameraZoom);
    if (progress >= 1.0 || s.rampStartWidthPoints <= 0.0) {
        return s.widthPoints;
    }
    return s.rampStartWidthPoints * pow(s.widthPoints / s.rampStartWidthPoints, progress);
}

fn tilePointWidthRampAlpha(s: LineStyle, cameraZoom: f32) -> f32 {
    return mix(s.rampStartAlpha, 1.0, tilePointWidthRampProgress(s, cameraZoom));
}

/// One up to the world lock zoom, doubling with every zoom level past it.
fn tilePointWidthWorldScale(worldLockZoom: f32, cameraZoom: f32) -> f32 {
    if (worldLockZoom <= 0.0) {
        return 1.0;
    }
    return exp2(max(cameraZoom - worldLockZoom, 0.0));
}

/// The visible half-width of a line on screen, in pixels.
fn tileLineEdgePixels(s: LineStyle, pixelsPerUnit: f32, pixelsPerPoint: f32, cameraZoom: f32) -> f32 {
    if (s.widthPoints > 0.0) {
        return tilePointWidthPoints(s, cameraZoom) * 0.5 * pixelsPerPoint * tilePointWidthWorldScale(s.worldLockZoom, cameraZoom);
    }
    var edgePx = s.halfWidthUnits * pixelsPerUnit;
    if (s.minimumWidthPoints > 0.0) {
        edgePx = max(edgePx, s.minimumWidthPoints * 0.5 * pixelsPerPoint);
    }
    return edgePx;
}

/// The pixels one world unit of ground spans on screen along `axis` at a point
/// of the screen.
fn tileGroundPixelsPerWorldUnit(axis: vec2f, ndc: vec2f, viewDepth: f32, f: OverviewFade) -> f32 {
    let clipStep = f.groundAxisXClip * axis.x + f.groundAxisYClip * axis.y;
    let halfViewport = f.viewportSizePx * 0.5;
    return length((clipStep.xy - ndc * clipStep.z) * halfViewport) / max(viewDepth, 1e-6);
}

/// How much a point-locked deferred ribbon's width scales at a point of the
/// screen: one ground width per road, exactly its points wide along the view
/// through the centre, the perspective doing the rest.
fn tilePointWidthPerspectiveScale(f: OverviewFade, viewDepth: f32, axis: vec2f, ndc: vec2f) -> f32 {
    if (f.pointWidthReferenceDepth <= 0.0) {
        return 1.0;
    }
    if (f.pointWidthCentrePixelsPerWorldUnit <= 0.0 || dot(axis, axis) <= 1e-6) {
        return f.pointWidthReferenceDepth / max(viewDepth, 1e-6);
    }
    return tileGroundPixelsPerWorldUnit(normalize(axis), ndc, viewDepth, f) / f.pointWidthCentrePixelsPerWorldUnit;
}

/// The signed distance to the nearest dash boundary, positive inside a dash.
fn tileDashEdgeDistance(lineParameter: f32, dashUnits: f32, period: f32) -> f32 {
    var phase = lineParameter - period * floor(lineParameter / period);
    var centered = phase - dashUnits * 0.5;
    centered -= period * round(centered / period);
    return dashUnits * 0.5 - abs(centered);
}

/// The analytic coverage of line geometry. The derivatives are taken first:
/// fwidth needs the whole quad, so the caller keeps this in uniform control flow.
fn tileLineCoverage(lineDistance: f32, lineParameter: f32, lineStyle: vec4f, minimumWidthPoints: f32,
                    dashInTileUnits: f32, pixelsPerPoint: f32, dashUnitsPerPoint: f32, deferredEdgePx: f32) -> f32 {
    let sideSpan = max(fwidth(lineDistance), 1e-5);
    let parameterSpan = fwidth(lineParameter);
    let edgeThreshold = lineStyle.x;
    if (edgeThreshold <= 0.0) {
        return 1.0;
    }
    let rimPx = 1.0 / sideSpan;
    let widthPoints = lineStyle.y;
    var edgePx: f32;
    if (deferredEdgePx > 0.0) {
        edgePx = min(deferredEdgePx, rimPx - 0.5);
    } else if (widthPoints > 0.0) {
        edgePx = min(widthPoints * 0.5 * pixelsPerPoint, rimPx - 0.5);
    } else {
        edgePx = edgeThreshold * rimPx;
        if (minimumWidthPoints > 0.0) {
            let floorPx = min(minimumWidthPoints * 0.5 * pixelsPerPoint, rimPx - 0.5);
            edgePx = max(edgePx, floorPx);
        }
    }
    let sideDistancePx = edgePx - abs(lineDistance) * rimPx;
    var coverage = smoothstep(-0.5, 0.5, sideDistancePx);
    let dashLengthPoints = lineStyle.z;
    if (dashLengthPoints > 0.0) {
        let unitsPerPixel = parameterSpan;
        let unitScale = select(dashUnitsPerPoint, 1.0, dashInTileUnits > 0.5);
        let dashUnits = dashLengthPoints * unitScale;
        let gapUnits = lineStyle.w * unitScale;
        let period = dashUnits + gapUnits;
        if (unitsPerPixel > 1e-5 && dashUnits > 0.0 && gapUnits > 0.0) {
            let toEdge = tileDashEdgeDistance(lineParameter, dashUnits, period);
            coverage *= smoothstep(-0.5, 0.5, toEdge / unitsPerPixel);
        }
    } else {
        let endDistancePx = lineParameter / max(parameterSpan, 1e-5);
        coverage *= smoothstep(-0.5, 0.5, endDistancePx);
    }
    return coverage;
}

/// The zoom fade of a style: x the camera zoom of zero alpha, y of full alpha,
/// a smoothstep between them against the planning zoom.
fn tileStyleFade(zoomFade: vec2f, cameraZoom: f32) -> f32 {
    let span = zoomFade.y - zoomFade.x;
    var t: f32;
    if (span != 0.0) {
        t = clamp((cameraZoom - zoomFade.x) / span, 0.0, 1.0);
    } else {
        t = step(zoomFade.y, cameraZoom);
    }
    return t * t * (3.0 - 2.0 * t);
}

/// The coverage of a lines-class fragment from its style index, apart from the colour.
fn tileLineFragmentCoverage(s: LineStyle, lineDistance: f32, lineParameterRaw: f32, f: OverviewFade, dashUnitsPerPoint: f32, deferredEdgePx: f32) -> f32 {
    let lineParameter = select(lineParameterRaw / 32767.0, lineParameterRaw * 0.5, s.dashLengthPoints > 0.0);
    let widthPoints = select(0.0, tilePointWidthPoints(s, f.cameraZoom), s.widthPoints > 0.0);
    let packed = vec4f(s.edgeThreshold, widthPoints, s.dashLengthPoints, s.dashGapPoints);
    return tileLineCoverage(lineDistance, lineParameter, packed, s.minimumWidthPoints,
                            select(0.0, 1.0, s.dashInTileUnits > 0.0), f.pixelsPerPoint, dashUnitsPerPoint, deferredEdgePx);
}

/// A lines-class fragment resolves its whole style from its index: the colour
/// with its look, fade and ramp alpha, times the analytic coverage.
fn tileLineFragmentColor(style: Style, zoomFade: vec2f, s: LineStyle, lineDistance: f32, lineParameterRaw: f32,
                         f: OverviewFade, dashUnitsPerPoint: f32, deferredEdgePx: f32) -> vec4f {
    var color = tileLineZoomLook(s, style.color, f.cameraZoom);
    color.a *= tileStyleFade(zoomFade, f.cameraZoom);
    color.a *= tilePointWidthRampAlpha(s, f.cameraZoom);
    color.a *= tileLineFragmentCoverage(s, lineDistance, lineParameterRaw, f, dashUnitsPerPoint, deferredEdgePx);
    return color;
}
