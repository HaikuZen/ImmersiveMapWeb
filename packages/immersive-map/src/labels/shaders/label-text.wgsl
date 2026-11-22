// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The labels on the screen, drawn in the overlay pass over its own cleared
// depth: the place names and the POIs' names, the POIs' icon discs, the
// route sign plates and the road names. A port of the Swift engine's
// LabelTextVertex.metal, PoiSprite.metal, RouteShield.metal,
// RoadLabelTextVertex.metal and TextShader.metal.
//
// Every quad hangs off a point the CPU placed this frame (labels[] for the
// base labels, roadGlyphs[] for the road glyphs), in device pixels with the
// origin at the bottom left, and the label-local offset in layout points is
// scaled to pixels here. A label that lost its collision, is faded out or
// lies beyond the horizon moves all its vertices out of the clip volume, so
// no fragment of it is shaded. The labels rasterize at the far plane: the
// cleared overlay depth (1) passes their less-equal test, and the fill and
// halo depths written just short of it order the glyphs, so the halo of a
// later glyph never covers the fill of an earlier one.

/// The frame (label-gpu.ts): the drawable's orthographic matrix and the
/// display's pixels per point.
struct LabelFrame {
    screen: mat4x4f,
    pixelsPerPoint: f32,
}

/// One base label this frame (LabelFrameRecordLayout): its anchor on screen,
/// whether it is drawable, its shrink for distance, its fade and its box.
struct LabelFrameRecord {
    screenVisibleScale: vec4f,
    fadeSize: vec4f,
}

/// One road glyph this frame: where it is drawn, its angle, its instance's
/// fade (0 when hidden), and its centre in the label's layout.
struct RoadGlyphRecord {
    placement: vec4f,
    glyphLayout: vec4f,
}

/// One draw, read at its instance index (render/core/draw-parameters.ts,
/// 80 bytes). Text: colourA the fill, colourB the halo, params the halo
/// width and fill bias in pixels, the opacity and the halo softness. POI
/// discs: colourA the plate, colourB the icon, params.z the opacity. Route
/// plates: colourA the fill, colourB the border, colourC the band, params
/// the border width and corner radius in points, the band's share, the
/// shape. `shift` is the first label (or road glyph) of the draw's tile.
struct LabelDraw {
    colorA: vec4f,
    colorB: vec4f,
    colorC: vec4f,
    params: vec4f,
    shift: i32,
    unused0: i32,
    unused1: i32,
    unused2: i32,
}

@group(0) @binding(0) var<uniform> frame: LabelFrame;
@group(0) @binding(1) var<storage, read> labels: array<LabelFrameRecord>;
@group(0) @binding(2) var<storage, read> roadGlyphs: array<RoadGlyphRecord>;
@group(1) @binding(0) var<storage, read> draws: array<LabelDraw>;
@group(2) @binding(0) var atlas: texture_2d<f32>;
@group(2) @binding(1) var atlasSampler: sampler;

/// The world's depth for the road names (RoadLabelSceneDepthUniforms in
/// Swift): the GPU's camera matrix (its z is the depth the world pass wrote),
/// the inverse of the CPU's (it unprojects a pixel), the eye, the drawable in
/// pixels, and whether the test runs. With `enabled` 0 the depth is not read.
struct RoadLabelScene {
    projectionView: mat4x4f,
    inverseProjectionView: mat4x4f,
    eye: vec3f,
    enabled: u32,
    viewportSize: vec2f,
}
@group(3) @binding(0) var<uniform> roadScene: RoadLabelScene;
@group(3) @binding(1) var sceneDepth: texture_depth_2d;

// How far a glyph's place on the road moves toward the eye before its depth
// is taken, as a fraction of the distance: clear of the ground it lies on,
// without leaving its pixel. A wall between the road and the camera is
// nearer by far more.
const kRoadGlyphEyeStep: f32 = 0.01;

/// The depth of the road under a glyph: its pixel (bottom-left origin)
/// carried back along the eye ray to the ground plane (z = 0), a step toward
/// the eye, and projected. 0 where there is no such point, which no depth is
/// nearer than, so nothing is cut. A port of `roadGlyphAnchorDepth`.
fn roadGlyphAnchorDepth(pixel: vec2f) -> f32 {
    if (any(roadScene.viewportSize <= vec2f(0.0))) {
        return 0.0;
    }
    let ndc = pixel / roadScene.viewportSize * 2.0 - 1.0;
    let nearPoint = roadScene.inverseProjectionView * vec4f(ndc, 0.0, 1.0);
    let farPoint = roadScene.inverseProjectionView * vec4f(ndc, 0.5, 1.0);
    if (abs(nearPoint.w) < 1e-9 || abs(farPoint.w) < 1e-9) {
        return 0.0;
    }
    let a = nearPoint.xyz / nearPoint.w;
    let b = farPoint.xyz / farPoint.w;
    let heightChange = a.z - b.z;
    if (abs(heightChange) < 1e-9) {
        return 0.0;
    }
    let ground = a + (b - a) * (a.z / heightChange);
    let anchor = ground + (roadScene.eye - ground) * kRoadGlyphEyeStep;
    let clip = roadScene.projectionView * vec4f(anchor, 1.0);
    return select(0.0, clip.z / clip.w, clip.w > 0.0);
}

struct LabelVertexIn {
    @location(0) position: vec2f,
    @location(1) uv: vec2f,
    @location(2) labelIndex: i32,
    @location(3) spriteUV: vec2f,
}

struct LabelVertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) alpha: f32,
    @location(2) spriteUV: vec2f,
    @location(3) @interpolate(flat) drawIndex: u32,
    /// Road glyphs only: the depth of the road under the glyph, 0 for no test.
    @location(4) @interpolate(flat) anchorDepth: f32,
}

// The distance range the atlases were generated with, in texels.
const kLabelDistanceRange: f32 = 24.0;
const kLabelFillDepth: f32 = 0.99999976;
const kLabelHaloDepth: f32 = 0.99999988;

/// Outside the clip volume on one side: the rasterizer rejects the quad whole.
fn hiddenLabelClipPosition() -> vec4f {
    return vec4f(-2.0, -2.0, 0.0, 1.0);
}

/// A base label's quad: the glyph corner or the plate corner at its offset
/// from the label's anchor, the whole label shrunk about the anchor for its
/// distance. Used by the text, the POI discs and the route plates.
@vertex
fn labelVertex(in: LabelVertexIn, @builtin(instance_index) drawIndex: u32) -> LabelVertexOut {
    let draw = draws[drawIndex];
    let label = labels[in.labelIndex + draw.shift];
    let halfSize = label.fadeSize.yz * 0.5;
    let pixel = label.screenVisibleScale.xy + (in.position - halfSize) * (frame.pixelsPerPoint * label.screenVisibleScale.w);
    var out: LabelVertexOut;
    out.position = frame.screen * vec4f(pixel, 0.0, 1.0);
    out.position.z = out.position.w;
    let visible = label.screenVisibleScale.z != 0.0 && label.fadeSize.x > 0.0;
    out.alpha = select(0.0, label.fadeSize.x, visible);
    if (!visible) {
        out.position = hiddenLabelClipPosition();
    }
    out.uv = in.uv;
    out.spriteUV = in.spriteUV;
    out.drawIndex = drawIndex;
    out.anchorDepth = 0.0;
    return out;
}

/// A road glyph's quad: rotated by its angle about its place on the road.
@vertex
fn roadLabelVertex(in: LabelVertexIn, @builtin(instance_index) drawIndex: u32) -> LabelVertexOut {
    let draw = draws[drawIndex];
    let glyph = roadGlyphs[in.labelIndex + draw.shift];
    let local = (in.position - glyph.glyphLayout.xy) * frame.pixelsPerPoint;
    let s = sin(glyph.placement.z);
    let c = cos(glyph.placement.z);
    let rotated = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
    var out: LabelVertexOut;
    out.position = frame.screen * vec4f(glyph.placement.xy + rotated, 0.0, 1.0);
    out.position.z = out.position.w;
    let visible = glyph.placement.w > 0.0;
    out.alpha = glyph.placement.w;
    if (!visible) {
        out.position = hiddenLabelClipPosition();
    }
    out.uv = in.uv;
    out.spriteUV = in.spriteUV;
    out.drawIndex = drawIndex;
    // The whole glyph stands where it touches the road, like a sign: a wall
    // behind the road leaves it whole, one in front cuts it.
    out.anchorDepth = select(0.0, roadGlyphAnchorDepth(glyph.placement.xy), roadScene.enabled != 0u && visible);
    return out;
}

struct TextFragmentOut {
    @location(0) color: vec4f,
    @builtin(frag_depth) depth: f32,
}

/// The fill and the halo of one fragment from the two distance fields, in
/// pixels from the glyph's edge. The depth orders them: a fill fragment
/// writes the nearer of two far-plane depths and a halo fragment the farther,
/// under less-equal with depth write on, so a halo never lands on a fill that
/// is already there while a fill still lands on a halo. A fragment with no
/// coverage writes the far plane itself, which changes nothing.
fn shadeGlyph(sdfPxDist: f32, fillPxDist: f32, strokeWidthPx: f32, draw: LabelDraw, vertexAlpha: f32) -> TextFragmentOut {
    let fill = smoothstep(-0.5, 0.5, fillPxDist);
    // The halo ends where it always did, and fades in from there over its
    // softness's share of its width.
    let fadePx = strokeWidthPx * draw.params.w;
    let outer = smoothstep(-strokeWidthPx - 0.5, -strokeWidthPx + 0.5 + fadePx, sdfPxDist);
    // A style that asks for no halo gets none, exactly: the fill and the
    // outer edge come from two different fields, so at zero width their
    // difference is not reliably zero around a corner.
    let stroke = select(0.0, clamp(outer - fill, 0.0, 1.0), strokeWidthPx > 0.0);
    let coverage = clamp(fill + stroke, 0.0, 1.0);
    let alpha = coverage * vertexAlpha * draw.params.z;
    let color = (fill * draw.colorA.rgb + stroke * draw.colorB.rgb) / max(coverage, 1.0e-4);
    var out: TextFragmentOut;
    out.color = vec4f(color, alpha);
    out.depth = select(select(1.0, kLabelHaloDepth, stroke > 0.0), kLabelFillDepth, fill > 0.0);
    return out;
}

/// The median of the three MSDF channels and the plain SDF in alpha, both
/// centred on the edge.
fn sampleGlyphDistances(uv: vec2f) -> vec2f {
    let texel = textureSample(atlas, atlasSampler, uv);
    let msdf = max(min(texel.r, texel.g), min(max(texel.r, texel.g), texel.b)) - 0.5;
    return vec2f(msdf, texel.a - 0.5);
}

/// A point label's glyph. The halo is kept narrow enough that a large style
/// value cannot fill the glyph quad.
@fragment
fn labelTextFragment(in: LabelVertexOut) -> TextFragmentOut {
    let distances = sampleGlyphDistances(in.uv);
    let textureSize = vec2f(textureDimensions(atlas));
    let unitRange = vec2f(kLabelDistanceRange) / textureSize;
    let screenTextureSize = 1.0 / max(fwidth(in.uv), vec2f(1e-6));
    let screenPxRange = max(0.5 * dot(unitRange, screenTextureSize), 1.0);
    let draw = draws[in.drawIndex];
    let strokeWidthPx = min(draw.params.x, max(0.5 * screenPxRange - 0.5, 0.0));
    return shadeGlyph(distances.y * screenPxRange, distances.x * screenPxRange + draw.params.y, strokeWidthPx, draw, in.alpha);
}

/// A road name's glyph. It is rotated along its road, and fwidth sums the uv
/// derivatives of both screen axes, so on a glyph turned by 45 degrees it
/// reads the range about 1.4 times too small: the range comes from the
/// length of the derivatives instead, the same at every angle.
@fragment
fn roadLabelTextFragment(in: LabelVertexOut) -> TextFragmentOut {
    // The buildings and the models paint over the road names behind them: a
    // pixel of the name is dropped where the world pass drew something nearer
    // than the glyph's place on the road. The ground's depth is a band at the
    // far plane, so only a building or a model cuts. The sample comes first:
    // the derivatives below need the whole quad.
    let size = textureDimensions(sceneDepth);
    let pixel = vec2u(in.position.xy);
    let depth = textureLoad(sceneDepth, min(pixel, size - 1u), 0);
    let hidden = roadScene.enabled != 0u && pixel.x < size.x && pixel.y < size.y && depth < in.anchorDepth;
    let distances = sampleGlyphDistances(in.uv);
    let textureSize = vec2f(textureDimensions(atlas));
    let texelsPerPixelX = dpdx(in.uv) * textureSize;
    let texelsPerPixelY = dpdy(in.uv) * textureSize;
    let texelsPerPixel = sqrt(0.5 * (dot(texelsPerPixelX, texelsPerPixelX) + dot(texelsPerPixelY, texelsPerPixelY)));
    let screenPxRange = max(kLabelDistanceRange / max(texelsPerPixel, 1e-6), 1.0);
    let draw = draws[in.drawIndex];
    // The halo stays inside the distance field's support, half the range past the glyph edge.
    let strokeWidthPx = min(draw.params.x, max(0.5 * screenPxRange - 0.5, 0.0));
    if (hidden) {
        discard;
    }
    return shadeGlyph(distances.y * screenPxRange, distances.x * screenPxRange + draw.params.y, strokeWidthPx, draw, in.alpha);
}

/// A POI's icon over its disc: the icon's coverage from the sprite atlas,
/// the disc from the quad's corner, composited and faded as one.
@fragment
fn poiSpriteFragment(in: LabelVertexOut) -> @location(0) vec4f {
    let texel = textureSample(atlas, atlasSampler, in.uv);
    let draw = draws[in.drawIndex];
    let centered = in.spriteUV * 2.0 - 1.0;
    let circleAlpha = 1.0 - smoothstep(0.82, 0.96, length(centered));
    let backgroundAlpha = circleAlpha * in.alpha * draw.colorA.a;
    let foregroundAlpha = texel.a * in.alpha * draw.colorB.a;
    let alpha = foregroundAlpha + backgroundAlpha * (1.0 - foregroundAlpha);
    let color = draw.colorB.rgb * foregroundAlpha + draw.colorA.rgb * backgroundAlpha * (1.0 - foregroundAlpha);
    // The pipeline blends by the source alpha, so the opacity scales the
    // alpha alone: the composite fades as one.
    return vec4f(color, alpha * draw.params.z);
}

fn roundedBoxDistance(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
    let r = min(radius, min(halfSize.x, halfSize.y));
    let q = abs(p) - halfSize + r;
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

/// A heraldic shield: the box down to where the sides start to curve, and
/// below that the lens two circles cut, one through each side, meeting in a
/// point at the bottom.
fn escutcheonDistance(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
    let box = roundedBoxDistance(p, halfSize, radius);
    let depth = min(1.15 * halfSize.x, 1.6 * halfSize.y);
    let shoulder = -halfSize.y + depth;
    let centreOffset = max((depth * depth - halfSize.x * halfSize.x) / (2.0 * halfSize.x), 0.0);
    let arcRadius = halfSize.x + centreOffset;
    let left = length(p - vec2f(-centreOffset, shoulder)) - arcRadius;
    let right = length(p - vec2f(centreOffset, shoulder)) - arcRadius;
    return select(max(box, max(left, right)), box, p.y >= shoulder);
}

/// The plate behind a route number, from its distance field: `uv` carries
/// the plate's size in points and `spriteUV` the corner, so the distances
/// are in points and the antialiasing reads the screen's rate of change of
/// them. The shapes are all evaluated so the derivatives stay in uniform
/// control flow: 0 the rectangle, 1 the capsule, 2 the escutcheon.
@fragment
fn routeShieldFragment(in: LabelVertexOut) -> @location(0) vec4f {
    let draw = draws[in.drawIndex];
    let size = in.uv;
    let halfSize = size * 0.5;
    let p = (in.spriteUV - 0.5) * size;
    let shape = u32(draw.params.w);
    let rectangle = roundedBoxDistance(p, halfSize, draw.params.y);
    let capsule = roundedBoxDistance(p, halfSize, min(halfSize.x, halfSize.y));
    let escutcheon = escutcheonDistance(p, halfSize, draw.params.y);
    let distance = select(select(rectangle, escutcheon, shape == 2u), capsule, shape == 1u);
    let aa = max(fwidth(distance), 1.0e-4);
    let headerAA = max(fwidth(p.y), 1.0e-4);
    let coverage = saturate(0.5 - distance / aa);
    let inside = select(1.0, saturate(0.5 - (distance + draw.params.x) / aa), draw.params.x > 0.0);
    var body = draw.colorA.rgb;
    if (draw.params.z > 0.0) {
        let headerEdge = halfSize.y - size.y * draw.params.z;
        let header = saturate(0.5 + (p.y - headerEdge) / headerAA);
        body = mix(body, draw.colorC.rgb, header);
    }
    let color = mix(draw.colorB.rgb, body, inside);
    return vec4f(color, coverage * in.alpha);
}
