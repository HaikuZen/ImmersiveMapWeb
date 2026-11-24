// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: ../../globe/shaders/clip-distances.wgsl ../../globe/shaders/globe.wgsl
// The grid of tiles an app's user picks tiles on (TileGridRenderSubsystem),
// a port of the Swift engine's TileGrid.metal: the border of every tile, the
// fill of a selected one, and each tile's text lying in its plane. A point
// of the grid is a tile's own uv (u east, v SOUTH, 0 to 1 across the tile),
// projected the ground's own way on the surface the frame draws
// (kTileGridSurface), as the layers of the app's data are (layers.wgsl):
//
// - the flat map, from the tile's origin and size in the render world,
// - the resting sphere, the unit earth direction through the composed
//   sphere matrix,
// - the unroll, the sphere-to-plane unroll with its cut.
//
// The border is not geometry: the fragment stage measures how far the pixel
// is from the tile's edge on screen and paints the line there, as wide in
// points at every zoom, each tile the half of the line inside its own edge.
// The tiles do not overlap, so a pixel of the ground is shaded once at the
// most. What the fragment stage is run over is the one thing that differs
// from the Swift engine (docs/benchmarks/B23-tile-grid.md):
//
// - a selected tile is a patch, an instance of a lattice the pipeline holds,
//   so a coarse tile curves with the sphere, and every pixel of it is shaded
//   for its fill (tileGridPatchVertex);
// - a tile that is not selected has nothing to paint but its border, so it
//   is drawn as a frame: a band along its four edges, as wide on screen as
//   the line and a margin, mitred at the corners so the bands of two edges
//   never overlap (tileGridFrameVertex). The pixels inside the tile are not
//   shaded at all.
//
// A glyph is a quad whose corners are tile uv, so the text turns, tilts and
// curves with its tile and grows with it. Everything is blended and unlit,
// and drawn in the overlay pass, over the finished world and the map's
// names, untested against any depth: the grid is a tool laid over the map,
// and nothing the map draws covers a border or a tile's numbers.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One tile of the frame, 32 bytes, as crates/map-frame writes it (tile_grid.rs).
struct TileGridTile {
    /// The tile's south-west corner and its size in the flat render world (the flat surface).
    flatOrigin: vec2f,
    flatSize: f32,
    /// The world x the unroll unwraps the tile around.
    referenceWorldX: f32,
    /// The tile's world uv origin (its north-west corner) and size (the sphere and the unroll).
    uvOrigin: vec2f,
    uvScale: f32,
    /// kTileGridFlagSelected, kTileGridFlagFillOnly, and from bit 8 up how finely the tile is divided, as the power of two.
    flags: u32,
}

/// A glyph of the atlas, 32 bytes (tile-grid-labels.ts): its box about the
/// pen in ems (left, bottom, right, top, y up) and its place in the atlas
/// (left, bottom, right, top, v down).
struct TileGridAtlasGlyph {
    plane: vec4f,
    uv: vec4f,
}

/// The frame's look, 96 bytes. Mirrors `TileGridFrameLayout` in tile-grid-pipeline.ts.
struct TileGridFrame {
    lineColor: vec4f,
    selectedFillColor: vec4f,
    labelColor: vec4f,
    labelHaloColor: vec4f,
    /// The drawable, in pixels.
    viewport: vec2f,
    /// Half the border's width, in pixels: the half a tile draws.
    halfLineWidthPx: f32,
    /// The borders fade out as a tile gets narrower on screen than this.
    minimumTilePx: f32,
    /// The clip-space depth the grid lies at (TileGridDepth).
    depth: f32,
    /// The atlas's distance range, in texels.
    atlasDistanceRange: f32,
    /// Atlas texels per em.
    atlasEmTexels: f32,
    haloWidthPx: f32,
    /// The narrowest a tile that shows its text is on screen, in pixels: a text fades out by it.
    labelMinimumTilePx: f32,
    padding0: f32,
    padding1: f32,
    padding2: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> globe: GlobeFrame;
@group(0) @binding(2) var<uniform> frame: TileGridFrame;
@group(0) @binding(3) var<storage, read> tiles: array<TileGridTile>;
@group(0) @binding(4) var<storage, read> atlasGlyphs: array<TileGridAtlasGlyph>;
@group(0) @binding(5) var atlas: texture_2d<f32>;
@group(0) @binding(6) var atlasSampler: sampler;

/// The surface the frame draws: 0 the flat map, 1 the resting sphere, 2 the unroll.
override kTileGridSurface: u32 = 0u;

// The scale the projection applies to the z of everything real
// (RenderCamera.realDepthScale): the flat surface and the unroll divide it
// out and apply the grid's own depth, which keeps it within the clip volume
// and is tested against nothing.
const kTileGridRealDepthScale: f32 = 1.0 - 1536.0 * 3.2e-6;
// The points along a side of the lattice a patch is cut from (TileGridPipeline.latticeSide + 1).
const kTileGridLatticePoints: u32 = 65u;
const kTileGridFlagSelected: u32 = 1u;
const kTileGridFlagFillOnly: u32 = 2u;
const kTileGridSubdivisionShift: u32 = 8u;
// A point nearer the camera than this in clip w is behind it.
const kTileGridNearW: f32 = 1.0e-4;
// What a frame's band reaches past the line, in pixels: the line's soft
// edge, and room for the band's width to be measured at the tile's edge
// and not at the pixel.
const kTileGridFrameMarginPx: f32 = 2.0;
// The step in tile uv the screen's scale is measured over at a frame's vertex.
const kTileGridFrameProbe: f32 = 1.0 / 64.0;

/// A point of the surface in clip space.
struct TileGridClip {
    position: vec4f,
    // Negative where the surface hides the point: the far side of the sphere, the unroll's cut.
    clearance: f32,
}

/// A point of a tile, by its uv, on the frame's surface. The one place the
/// tile's v, which grows south, meets the render world's y, which grows north.
fn tileGridProject(tileUV: vec2f, tile: TileGridTile) -> TileGridClip {
    var clip: TileGridClip;
    if (kTileGridSurface == 0u) {
        let world = tile.flatOrigin + vec2f(tileUV.x, 1.0 - tileUV.y) * tile.flatSize;
        clip.position = camera.matrix * vec4f(world, 0.0, 1.0);
        clip.position.z *= frame.depth / kTileGridRealDepthScale;
        clip.clearance = 1.0;
        return clip;
    }
    let worldUv = tile.uvOrigin + tileUV * tile.uvScale;
    let morph = kTileGridSurface == 2u;
    let point = globeSurfacePoint(worldUv, tile.referenceWorldX, morph, globe);
    clip.position = globeSurfaceClip(point, morph, camera.matrix, globe);
    if (morph) {
        clip.position.z *= frame.depth / kTileGridRealDepthScale;
        clip.clearance = point.clearance;
    } else {
        clip.position.z = frame.depth * clip.position.w;
        // The far side of the planet: a patch that crosses the limb is cut
        // where the sphere turns away from the eye.
        clip.clearance = dot(normalize(point.normal), normalize(camera.eye - point.world));
    }
    return clip;
}

// MARK: The border and the selected fill

struct TileGridPatchOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) tileUV: vec2f,
    @location(1) @interpolate(flat) flags: u32,
    @location(2) cutClearance: f32, // no-clip-distances
}

struct TileGridPatchFragmentIn {
    @location(0) tileUV: vec2f,
    @location(1) @interpolate(flat) flags: u32,
    @location(2) cutClearance: f32, // no-clip-distances
}

fn tileGridPatchOutput(tileUV: vec2f, tile: TileGridTile) -> TileGridPatchOut {
    let clip = tileGridProject(tileUV, tile);
    var out: TileGridPatchOut;
    out.position = clip.position;
    out.cut[0] = clip.clearance; // clip-distances
    out.cutClearance = clip.clearance; // no-clip-distances
    out.tileUV = tileUV;
    out.flags = tile.flags;
    return out;
}

/// A whole tile: a point of the lattice, by its index alone.
@vertex
fn tileGridPatchVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) tileIndex: u32) -> TileGridPatchOut {
    let tileUV = vec2f(f32(vertexIndex % kTileGridLatticePoints), f32(vertexIndex / kTileGridLatticePoints)) / f32(kTileGridLatticePoints - 1u);
    return tileGridPatchOutput(tileUV, tiles[tileIndex]);
}

/// Where a point of a tile is on screen, in pixels, `ok` false behind the camera.
struct TileGridScreen {
    pixel: vec2f,
    ok: bool,
}

fn tileGridScreen(tileUV: vec2f, tile: TileGridTile) -> TileGridScreen {
    let clip = tileGridProject(tileUV, tile).position;
    var screen: TileGridScreen;
    screen.ok = clip.w > kTileGridNearW;
    screen.pixel = clip.xy / max(clip.w, kTileGridNearW) * frame.viewport * 0.5;
    return screen;
}

/// How far into a tile a band of `reachPx` pixels along each of its edges
/// reaches at a point of its edge, in the tile's u and v: the fragment stage
/// measures a pixel's distance from an edge across the lines of equal u (or
/// v), so the band is as wide as that distance needs, whichever way the tile
/// is turned and tilted. Half the tile, the whole of it, where the scale
/// cannot be measured.
fn tileGridFrameInset(edgeUV: vec2f, tile: TileGridTile, reachPx: f32) -> vec2f {
    // The probes step into the tile.
    let step = vec2f(select(kTileGridFrameProbe, -kTileGridFrameProbe, edgeUV.x > 0.5), select(kTileGridFrameProbe, -kTileGridFrameProbe, edgeUV.y > 0.5));
    let here = tileGridScreen(edgeUV, tile);
    let alongU = tileGridScreen(edgeUV + vec2f(step.x, 0.0), tile);
    let alongV = tileGridScreen(edgeUV + vec2f(0.0, step.y), tile);
    if (!(here.ok && alongU.ok && alongV.ok)) {
        return vec2f(0.5);
    }
    let perU = (alongU.pixel - here.pixel) / kTileGridFrameProbe;
    let perV = (alongV.pixel - here.pixel) / kTileGridFrameProbe;
    let area = abs(perU.x * perV.y - perU.y * perV.x);
    if (!(area > 1.0e-12)) {
        return vec2f(0.5);
    }
    // The gradient of u is as long as v's step on screen over the area the two steps span.
    return min(vec2f(length(perV), length(perU)) * (reachPx / area), vec2f(0.5));
}

/// A tile that is not selected: the band along its edges alone. The draw
/// has twenty-four vertices for every quad a side of the tile is divided
/// into: the four sides one after another, each a run of quads from the
/// edge to the band's inner edge.
@vertex
fn tileGridFrameVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) tileIndex: u32) -> TileGridPatchOut {
    let tile = tiles[tileIndex];
    let subdivision = 1u << ((tile.flags >> kTileGridSubdivisionShift) & 0xFu);
    let quad = vertexIndex / 6u;
    let side = (quad / subdivision) % 4u;
    // The quad's corners: how far along the side, and whether on the edge or the band's inner edge.
    var corners = array<vec2u, 6>(vec2u(0u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 1u));
    let corner = corners[vertexIndex % 6u];
    let along = f32(quad % subdivision + corner.x) / f32(subdivision);
    // The sides: north (v 0), south (v 1), west (u 0), east (u 1).
    var edgeUV: vec2f;
    if (side == 0u) { edgeUV = vec2f(along, 0.0); }
    else if (side == 1u) { edgeUV = vec2f(along, 1.0); }
    else if (side == 2u) { edgeUV = vec2f(0.0, along); }
    else { edgeUV = vec2f(1.0, along); }
    var tileUV = edgeUV;
    if (corner.y == 1u) {
        let reachPx = frame.halfLineWidthPx + kTileGridFrameMarginPx;
        let inset = tileGridFrameInset(edgeUV, tile, reachPx);
        // Into the tile across the side, and at the side's ends along it
        // too: the band's inner corner is the same point for the two sides
        // that meet there, so their bands share a mitre and no pixel.
        let inner = vec2f(select(edgeUV.x + inset.x, edgeUV.x - inset.x, edgeUV.x > 0.5), select(edgeUV.y + inset.y, edgeUV.y - inset.y, edgeUV.y > 0.5));
        if (side < 2u) {
            tileUV = vec2f(select(edgeUV.x, inner.x, along <= 0.0 || along >= 1.0), inner.y);
        } else {
            tileUV = vec2f(inner.x, select(edgeUV.y, inner.y, along <= 0.0 || along >= 1.0));
        }
    }
    return tileGridPatchOutput(tileUV, tile);
}

@fragment
fn tileGridPatchFragment(in: TileGridPatchFragmentIn) -> @location(0) vec4f {
    // How fast each axis of the tile's uv crosses the screen, per pixel: the
    // length of its gradient, so a turned grid keeps its width.
    let perPixelU = max(length(vec2f(dpdx(in.tileUV.x), dpdy(in.tileUV.x))), 1.0e-9);
    let perPixelV = max(length(vec2f(dpdx(in.tileUV.y), dpdy(in.tileUV.y))), 1.0e-9);
    if (in.cutClearance < 0.0) { discard; } // no-clip-distances
    let toEdge = min(in.tileUV, 1.0 - in.tileUV);
    let edgePx = min(toEdge.x / perPixelU, toEdge.y / perPixelV);
    // The tile's width on screen along the axis the view squeezes most.
    let tilePx = 1.0 / max(perPixelU, perPixelV);

    var line = 1.0 - smoothstep(frame.halfLineWidthPx - 0.5, frame.halfLineWidthPx + 0.5, edgePx);
    line *= smoothstep(0.5 * frame.minimumTilePx, frame.minimumTilePx, tilePx);
    if ((in.flags & kTileGridFlagFillOnly) != 0u) {
        line = 0.0;
    }
    let lineAlpha = line * frame.lineColor.a;
    let fillAlpha = select(0.0, frame.selectedFillColor.a, (in.flags & kTileGridFlagSelected) != 0u);

    // The line over the fill, as one straight-alpha colour.
    let alpha = lineAlpha + fillAlpha * (1.0 - lineAlpha);
    let color = (frame.lineColor.rgb * lineAlpha + frame.selectedFillColor.rgb * fillAlpha * (1.0 - lineAlpha)) / max(alpha, 1.0e-5);
    return vec4f(color, alpha);
}

// MARK: The text

struct TileGridGlyphIn {
    /// The tile in the frame's tiles in the low half, the glyph in the atlas's table in the high half.
    @location(0) tileAndGlyph: u32,
    /// The pen from the text's middle, in ems: x right, y up.
    @location(1) pen: vec2f,
    /// The share of the tile's side one em takes.
    @location(2) share: f32,
}

struct TileGridGlyphOut {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) cut: array<f32, 1>, // clip-distances
    @location(0) atlasUV: vec2f,
    /// The text fades out as its em gets smaller on screen than this, in
    /// pixels: what it spans in the narrowest tile that shows texts.
    @location(1) @interpolate(flat) minimumEmPx: f32,
    /// 1 for the halo draw, 0 for the fill draw.
    @location(2) @interpolate(flat) haloPass: u32,
    @location(3) cutClearance: f32, // no-clip-distances
}

struct TileGridGlyphFragmentIn {
    @location(0) atlasUV: vec2f,
    @location(1) @interpolate(flat) minimumEmPx: f32,
    @location(2) @interpolate(flat) haloPass: u32,
    @location(3) cutClearance: f32, // no-clip-distances
}

/// A glyph is an instance and its quad six vertices. The fill's draw starts
/// at vertex 0 and the halo's at vertex 6, so the two read the same glyphs.
@vertex
fn tileGridGlyphVertex(in: TileGridGlyphIn, @builtin(vertex_index) vertexIndex: u32) -> TileGridGlyphOut {
    var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
    let corner = corners[vertexIndex % 6u];
    let glyph = atlasGlyphs[in.tileAndGlyph >> 16u];
    let offsetEm = in.pen + mix(glyph.plane.xy, glyph.plane.zw, corner);
    // The text's y grows up and the tile's v grows south.
    let tileUV = vec2f(0.5 + offsetEm.x * in.share, 0.5 - offsetEm.y * in.share);
    let clip = tileGridProject(tileUV, tiles[in.tileAndGlyph & 0xFFFFu]);
    var out: TileGridGlyphOut;
    out.position = clip.position;
    out.cut[0] = clip.clearance; // clip-distances
    out.cutClearance = clip.clearance; // no-clip-distances
    out.atlasUV = mix(glyph.uv.xy, glyph.uv.zw, corner);
    out.minimumEmPx = frame.labelMinimumTilePx * in.share;
    out.haloPass = vertexIndex / 6u;
    return out;
}

/// The glyph's distance fields in screen pixels: the multi-channel field for
/// the fill, the true field in the alpha for the halo, which reaches past
/// the glyph. The pixel range comes from the uv derivatives, so it follows
/// the glyph's size on screen through the perspective and the zoom
/// (surfaceLabelFragment in surface-label.wgsl).
@fragment
fn tileGridGlyphFragment(in: TileGridGlyphFragmentIn) -> @location(0) vec4f {
    let texel = textureSample(atlas, atlasSampler, in.atlasUV);
    let screenTextureSize = 1.0 / max(fwidth(in.atlasUV), vec2f(1.0e-6));
    if (in.cutClearance < 0.0) { discard; } // no-clip-distances
    let msdfDistance = max(min(texel.r, texel.g), min(max(texel.r, texel.g), texel.b)) - 0.5;
    let sdfDistance = texel.a - 0.5;
    let unitRange = vec2f(frame.atlasDistanceRange) / vec2f(textureDimensions(atlas));
    let screenPxRange = max(0.5 * dot(unitRange, screenTextureSize), 1.0);
    // Screen pixels per atlas texel, and so per em.
    let pixelsPerTexel = screenPxRange / max(frame.atlasDistanceRange, 1.0);
    let emPx = pixelsPerTexel * frame.atlasEmTexels;

    var coverage: f32;
    var color: vec4f;
    if (in.haloPass != 0u) {
        // The halo reaches past the glyph by its width, bounded by the distance field's support.
        let haloPx = min(frame.haloWidthPx, max(0.5 * screenPxRange - 0.5, 0.0));
        coverage = select(0.0, smoothstep(-haloPx - 0.5, -haloPx + 0.5, sdfDistance * screenPxRange), haloPx > 0.0);
        color = frame.labelHaloColor;
    } else {
        coverage = smoothstep(-0.5, 0.5, msdfDistance * screenPxRange);
        color = frame.labelColor;
    }
    // Far tiles under a tilt: the text goes before it turns to noise.
    coverage *= smoothstep(0.5 * in.minimumEmPx, in.minimumEmPx, emPx);
    return vec4f(color.rgb, coverage * color.a);
}
