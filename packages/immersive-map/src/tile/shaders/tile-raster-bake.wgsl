// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: tile-shading.wgsl
// The raster tiles' bake (RasterTileRenderSubsystem): a tile's fill runs
// drawn into its window of the frame's atlas, top down over the tile's
// extent, the style's colour in buffer order with its zoom fade at the
// planning zoom, as the vector ground draws it. A port of the bake half of
// the Swift engine's TileRaster.metal. Prepended with tile-shading.wgsl.

const kTileRasterExtent: f32 = 4096.0;

// The frame's uniforms (the tile pipelines' group 0): only the fade's zoom is read.
@group(0) @binding(1) var<uniform> overviewFade: OverviewFade;
// The tile's ground style tables (the tile pipelines' styles bind group).
@group(1) @binding(0) var<storage, read> styles: array<Style>;
@group(1) @binding(1) var<storage, read> styleZoomFades: array<vec2f>;

struct TileRasterBakeIn {
    @location(0) position: vec2f,
    @location(1) styleIndex: u32,
}

struct TileRasterBakeOut {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
}

@vertex
fn tileRasterBakeVertex(in: TileRasterBakeIn) -> TileRasterBakeOut {
    var out: TileRasterBakeOut;
    // The tile's extent fills the viewport (its window): local y up is clip
    // y up, which is the texture's first row at the north edge.
    let clip = in.position / kTileRasterExtent * 2.0 - 1.0;
    out.position = vec4f(clip, 0.0, 1.0);
    var color = styles[in.styleIndex].color;
    color.a *= tileStyleFade(styleZoomFades[in.styleIndex], overviewFade.cameraZoom);
    out.color = color;
    return out;
}

@fragment
fn tileRasterBakeFragment(in: TileRasterBakeOut) -> @location(0) vec4f {
    return in.color;
}
