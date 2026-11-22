// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The pins, a port of PinCommon.h, PinRender.metal and PinBeam.metal: the
// beams from a pushed pin to its place, the pins in the frame of the map's
// shape (cut from a distance field, morphing into a circle when pushed),
// and the counters of merged pins. Drawn in the overlay pass in screen
// pixels (origin bottom left, y up), one instance a pin, without depth.

// Mirrors `PinFrameUniform` in pins-gpu.ts.
struct PinStyleGPU {
    sizePx: vec2f,
    anchorUv: vec2f,
    bodyCenterUv: vec2f,
    bodyHalfUv: vec2f,
    circleRadiusUv: f32,
    outlineWidthPx: f32,
    contentInsetPx: f32,
    distanceRangeTexels: f32,
    fillColor: vec4f,
    frameless: u32,
    distanceInAlpha: u32,
    _pad1: vec2f,
}

struct PinFrameUniform {
    screenMatrix: mat4x4f,
    style: PinStyleGPU,
    // The beam: from the pin's anchor to the centre of its circle at scale 1, and the circle's radius.
    beamPinCenterOffsetPx: vec2f,
    beamPinBodyHalfMinPx: f32,
    _pad2: f32,
    beamColor: vec4f,
    // The counter: its size and its lower left corner from the anchor.
    badgeSizePx: vec2f,
    badgeOriginPx: vec2f,
}

// One pin of the frame, 128 bytes (`PIN_RECORD_BYTES` in pins-gpu.ts): the
// Swift `ScreenPointOutput`, `PinInstanceGPU`, `PinCountBadgeInstanceGPU`,
// the beam's anchor and `PinOffset`, in one record.
struct PinRecord {
    position: vec2f,
    visibilityAlpha: f32,
    visible: u32,
    uvRect: vec4f,
    borderColor: vec4f,
    squashScale: vec2f,
    atlasIndex: u32,
    flags: u32,
    morph: f32,
    badgeContentAlpha: f32,
    badgeFlags: u32,
    screenSizeScale: f32,
    badgeUvRect: vec4f,
    beamAnchor: vec2f,
    beamAnchorVisible: u32,
    beamAnchorAlpha: f32,
    beamOffset: vec2f,
    beamScale: f32,
    _pad3: f32,
}

@group(0) @binding(0) var<uniform> frame: PinFrameUniform;
@group(0) @binding(1) var<storage, read> pins: array<PinRecord>;
@group(0) @binding(2) var atlasTexture: texture_2d_array<f32>;
@group(0) @binding(3) var sdfTexture: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var badgeAtlas: texture_2d<f32>;

const quad = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
const hiddenPosition = vec4f(-2.0, -2.0, 0.0, 1.0);

// Reveal thresholds match PinCollisionMath.displacedMorph*: the beam
// appears together with the pushed pin morphing into a circle.
const kDisplacedRevealStartPx: f32 = 2.0;
const kDisplacedRevealEndPx: f32 = 10.0;

struct PinVertexOut {
    @builtin(position) position: vec4f,
    @location(0) uvLocal: vec2f,
    @location(1) uvRect: vec4f,
    @location(2) borderColor: vec4f,
    @location(3) visibilityAlpha: f32,
    @location(4) morph: f32,
    @location(5) @interpolate(flat) atlasIndex: u32,
    @location(6) @interpolate(flat) flags: u32,
}

fn decodeSignedDistanceTexels(encodedDistance: f32) -> f32 {
    return (0.5 - encodedDistance) * (2.0 * frame.style.distanceRangeTexels);
}

@vertex
fn pinVertex(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> PinVertexOut {
    var out: PinVertexOut;
    let pin = pins[iid];
    if (pin.visible == 0u) {
        out.position = hiddenPosition;
        out.uvLocal = vec2f(0.0);
        out.uvRect = vec4f(0.0);
        out.borderColor = vec4f(0.0);
        out.visibilityAlpha = 0.0;
        out.morph = 0.0;
        out.atlasIndex = 0u;
        out.flags = 0u;
        return out;
    }
    // The quad is laid so that the shape's anchor stands on the pin's point.
    let uv = quad[vid];
    let local = (uv - frame.style.anchorUv) * frame.style.sizePx * pin.squashScale;
    out.position = frame.screenMatrix * vec4f(pin.position + local, 0.0, 1.0);
    out.uvLocal = uv;
    out.uvRect = pin.uvRect;
    out.borderColor = pin.borderColor;
    out.visibilityAlpha = pin.visibilityAlpha;
    out.morph = pin.morph;
    out.atlasIndex = pin.atlasIndex;
    out.flags = pin.flags;
    return out;
}

// The pipeline blends by the source's alpha, so the color leaves the
// shader not multiplied by it. The atlas holds premultiplied pictures.
@fragment
fn pinFragment(in: PinVertexOut) -> @location(0) vec4f {
    let style = frame.style;
    // The derivatives are taken before any branch (uniform control flow).
    let sdfTextureSize = vec2f(textureDimensions(sdfTexture));
    let texelsPerPixelX = length(dpdx(in.uvLocal) * sdfTextureSize);
    let texelsPerPixelY = length(dpdy(in.uvLocal) * sdfTextureSize);
    let sdfUv = vec2f(in.uvLocal.x, 1.0 - in.uvLocal.y);
    let sdfSample = textureSample(sdfTexture, linearSampler, sdfUv);
    let pictureUv = mix(in.uvRect.xy, in.uvRect.zw, in.uvLocal);
    let picture = textureSample(atlasTexture, linearSampler, pictureUv, in.atlasIndex);

    // The picture is laid into the picture area, set in by the inset, and is
    // centered on the circle a pushed pin turns into.
    let circleCenter = style.bodyCenterUv;
    let insetUv = vec2f(style.contentInsetPx) / max(style.sizePx, vec2f(1.0));
    let contentHalfUv = max(style.bodyHalfUv - insetUv, vec2f(0.0001));
    let imageUv = clamp((in.uvLocal - (circleCenter - contentHalfUv)) / (2.0 * contentHalfUv), vec2f(0.0), vec2f(1.0));
    let tex = textureSample(atlasTexture, linearSampler, mix(in.uvRect.xy, in.uvRect.zw, imageUv), in.atlasIndex);

    // A pin without a frame is its picture alone, cut by the picture's alpha.
    if (style.frameless != 0u) {
        return vec4f(picture.rgb / max(picture.a, 0.0001), picture.a * in.visibilityAlpha);
    }

    // A baked shape keeps its distance in red, the built-in bubble in alpha.
    let encodedDistance = select(sdfSample.r, sdfSample.a, style.distanceInAlpha != 0u);
    let pinDistanceTexels = decodeSignedDistanceTexels(encodedDistance);
    // Pin to circle morph: an analytic distance to the body circle in the
    // same texels as the shape's sample, so the masks below stay unchanged.
    let circleRadiusTexels = style.circleRadiusUv * sdfTextureSize.x;
    let circleDistanceTexels = length((in.uvLocal - circleCenter) * sdfTextureSize) - circleRadiusTexels;
    let shapeDistanceTexels = mix(pinDistanceTexels, circleDistanceTexels, saturate(in.morph));
    let texelsPerPixel = max(max(texelsPerPixelX, texelsPerPixelY), 0.0001);
    let edgeWidthTexels = max(0.75 * texelsPerPixel, 0.75);
    let outlineWidthTexels = max(style.outlineWidthPx * texelsPerPixel, edgeWidthTexels);
    let fillMask = 1.0 - smoothstep(-edgeWidthTexels, edgeWidthTexels, shapeDistanceTexels);
    // An outline of no width is no outline, not a hairline.
    let borderMask = select(0.0, smoothstep(-outlineWidthTexels - edgeWidthTexels, -edgeWidthTexels, shapeDistanceTexels) * fillMask, style.outlineWidthPx > 0.0);
    let interiorMask = max(fillMask - borderMask, 0.0);
    let contentInsetTexels = max(style.contentInsetPx * texelsPerPixel, select(0.0, outlineWidthTexels + edgeWidthTexels, style.outlineWidthPx > 0.0));
    let imageMask = (1.0 - smoothstep(-contentInsetTexels - edgeWidthTexels, -contentInsetTexels + edgeWidthTexels, shapeDistanceTexels)) * interiorMask;

    // Everything below is multiplied by its own alpha until the last line.
    let fill = vec4f(style.fillColor.rgb * style.fillColor.a, style.fillColor.a);
    let outline = vec4f(in.borderColor.rgb * in.borderColor.a, in.borderColor.a);
    // A picture with transparent parts lies on the fill, not on the map.
    let pictureOnFill = tex + fill * (1.0 - tex.a);
    let fillBandMask = max(interiorMask - imageMask, 0.0);
    let color = pictureOnFill * imageMask + fill * fillBandMask + outline * borderMask;
    return vec4f(color.rgb / max(color.a, 0.0001), color.a * in.visibilityAlpha);
}

struct PinCountBadgeVertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) uvRect: vec4f,
    @location(2) visibilityAlpha: f32,
    @location(3) contentAlpha: f32,
}

@vertex
fn pinCountBadgeVertex(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> PinCountBadgeVertexOut {
    var out: PinCountBadgeVertexOut;
    let pin = pins[iid];
    if (pin.visible == 0u || (pin.badgeFlags & 1u) == 0u || pin.badgeContentAlpha <= 0.0) {
        out.position = hiddenPosition;
        out.uv = vec2f(0.0);
        out.uvRect = vec4f(0.0);
        out.visibilityAlpha = 0.0;
        out.contentAlpha = 0.0;
        return out;
    }
    let uv = quad[vid];
    let screenSizeScale = max(pin.screenSizeScale, 0.0);
    let local = (frame.badgeOriginPx + uv * frame.badgeSizePx) * screenSizeScale;
    out.position = frame.screenMatrix * vec4f(pin.position + local, 0.0, 1.0);
    out.uv = uv;
    out.uvRect = pin.badgeUvRect;
    out.visibilityAlpha = pin.visibilityAlpha;
    out.contentAlpha = pin.badgeContentAlpha;
    return out;
}

@fragment
fn pinCountBadgeFragment(in: PinCountBadgeVertexOut) -> @location(0) vec4f {
    var color = textureSample(badgeAtlas, linearSampler, mix(in.uvRect.xy, in.uvRect.zw, in.uv));
    // The atlas is premultiplied, the blend is not: the color is divided out first.
    color = vec4f(color.rgb / max(color.a, 0.0001), color.a * in.visibilityAlpha * in.contentAlpha);
    return color;
}

struct BeamVertexOut {
    @builtin(position) position: vec4f,
    @location(0) alpha: f32,
    // 0 at the geo point, 1 at the circle: the beam fades as it nears the geo point.
    @location(1) taper: f32,
}

// A cone from the geo point to the pushed circle: apex at the anchor, base
// at the circle's two tangent points. An undisplaced pin has no offset and
// draws no cone.
@vertex
fn pinBeamVertex(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> BeamVertexOut {
    var out: BeamVertexOut;
    out.position = hiddenPosition;
    out.alpha = 0.0;
    out.taper = 0.0;
    let pin = pins[iid];
    if (pin.beamAnchorVisible == 0u) {
        return out;
    }
    let anchor = pin.beamAnchor;
    let bubbleCenter = anchor + pin.beamOffset + frame.beamPinCenterOffsetPx * pin.beamScale;
    let direction = bubbleCenter - anchor;
    let len = length(direction);
    let radius = max(frame.beamPinBodyHalfMinPx * pin.beamScale, 1.0);
    if (len <= radius + 1.0) {
        return out;
    }
    let alpha = smoothstep(kDisplacedRevealStartPx, kDisplacedRevealEndPx, length(pin.beamOffset)) * pin.beamAnchorAlpha;
    if (alpha <= 0.001) {
        return out;
    }
    let dirNorm = direction / len;
    let perp = vec2f(-dirNorm.y, dirNorm.x);
    let tangentX = -radius * radius / len;
    let tangentY = radius * sqrt(max(len * len - radius * radius, 0.0)) / len;
    let corners = array<vec2f, 3>(anchor, bubbleCenter + dirNorm * tangentX + perp * tangentY, bubbleCenter + dirNorm * tangentX - perp * tangentY);
    let cornerTapers = array<f32, 3>(0.0, 1.0, 1.0);
    let triIndices = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 1u);
    let corner = triIndices[vid];
    out.position = frame.screenMatrix * vec4f(corners[corner], 0.0, 1.0);
    out.alpha = alpha;
    out.taper = cornerTapers[corner];
    return out;
}

@fragment
fn pinBeamFragment(in: BeamVertexOut) -> @location(0) vec4f {
    // Falloff toward the geo point by the power of 1.5: the beam is dense
    // at the circle and dissolves before the apex at the geo point.
    let taper = in.taper * sqrt(in.taper);
    return vec4f(frame.beamColor.rgb, frame.beamColor.a * in.alpha * taper);
}
