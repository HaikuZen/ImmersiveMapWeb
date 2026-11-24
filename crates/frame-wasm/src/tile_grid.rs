// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the tile grid's frame (`map_frame::tile_grid`): which
//! tiles the grid draws under a camera, the selected among them and the
//! glyphs of their texts, in one call a frame
//! (docs/benchmarks/B23-tile-grid.md). The selection and the texts are
//! copied in when they change and stay in Wasm memory, and the frame's
//! tiles and glyphs are read back from the module's memory at the addresses
//! the header gives, as the GPU takes them. The TypeScript side is
//! packages/immersive-map/src/tile-grid/tile-grid-frame.ts.

use map_frame::tile_grid::{FrameInput, TileGrid as Grid, TileGridSettings};
use map_visibility::grid::ZoomSettings;
use map_visibility::globe::GlobeUniform;
use map_visibility::FlatRenderState;
use wasm_bindgen::prelude::*;

/// The words of the header a frame leaves: the zoom the grid shows plus one
/// (zero for no grid), whether its tiles carry texts, the three runs of
/// tiles (the grid's not selected, the grid's selected, the other zooms'
/// selected), how finely the grid's and the other zooms' tiles are divided,
/// the glyphs, the tiles whose text is not known, then the addresses of the
/// tiles as the GPU takes them, the tiles' numbers, the glyphs and the
/// tiles asked for.
const HEADER_WORDS: usize = 16;

/// The grid of frame after frame.
#[wasm_bindgen]
pub struct TileGrid {
    grid: Grid,
    header: Box<[u32; HEADER_WORDS]>,
}

impl Default for TileGrid {
    fn default() -> TileGrid {
        TileGrid::new()
    }
}

#[wasm_bindgen]
impl TileGrid {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TileGrid {
        TileGrid { grid: Grid::new(), header: Box::new([0; HEADER_WORDS]) }
    }

    /// Where the header is in the module's memory, for good.
    #[wasm_bindgen(getter, js_name = headerPtr)]
    pub fn header_ptr(&self) -> *const u32 {
        self.header.as_ptr()
    }

    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = setSettings)]
    pub fn set_settings(&mut self, minimum_zoom: i32, maximum_zoom: i32, minimum_tile_screen_points: f64, label_minimum_tile_screen_points: f64, maximum_drawn_tiles: usize, label_maximum_width_share: f32, label_maximum_height_share: f32) {
        self.grid.set_settings(TileGridSettings {
            zoom: ZoomSettings { zoom_range: (minimum_zoom, maximum_zoom), minimum_tile_screen_points, label_minimum_tile_screen_points },
            maximum_drawn_tiles,
            label_maximum_width_share,
            label_maximum_height_share,
        });
    }

    /// Replaces the selected tiles: three ints each, zoom, x and y.
    #[wasm_bindgen(js_name = setSelection)]
    pub fn set_selection(&mut self, tiles: &[i32]) {
        self.grid.set_selection(tiles);
    }

    /// A text laid out, its glyphs four words each (`map_frame::tile_grid`). Returns its handle.
    #[wasm_bindgen(js_name = defineLayout)]
    pub fn define_layout(&mut self, width_em: f32, height_em: f32, records: &[u32]) -> u32 {
        self.grid.define_layout(width_em, height_em, records)
    }

    /// The texts of tiles, four ints each: zoom, x, y and the text's handle, -1 for a tile with none.
    #[wasm_bindgen(js_name = setTileLabels)]
    pub fn set_tile_labels(&mut self, labels: &[i32]) {
        for label in labels.as_chunks::<4>().0 {
            self.grid.set_tile_label(label[0], label[1], label[2], label[3] as u32);
        }
    }

    #[wasm_bindgen(js_name = clearTileLabels)]
    pub fn clear_tile_labels(&mut self) {
        self.grid.clear_tile_labels();
    }

    #[wasm_bindgen(js_name = clearLayouts)]
    pub fn clear_layouts(&mut self) {
        self.grid.clear_layouts();
    }

    #[wasm_bindgen(getter, js_name = layoutCount)]
    pub fn layout_count(&self) -> usize {
        self.grid.layout_count()
    }

    #[wasm_bindgen(getter, js_name = tileLabelCount)]
    pub fn tile_label_count(&self) -> usize {
        self.grid.tile_label_count()
    }

    /// The frame's grid, left in the header. `matrix` is the projection-view
    /// matrix, sixteen doubles. `on_globe`: the frame draws the sphere or
    /// the unroll, and the eye and the globe are read. The centre is the
    /// point the camera looks at in the normalized world. False when nothing
    /// changed since the frame before, and the header stands as it was.
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(&mut self, matrix: &[f64], on_globe: bool, pan_x: f64, pan_y: f64, render_map_size: f64, eye_x: f64, eye_y: f64, eye_z: f64, globe_pan_x: f64, globe_pan_y: f64, radius: f64, transition: f64, centre_x: f64, centre_y: f64, camera_zoom: f64, viewport_height_points: f64, tile_world_size: f64) -> bool {
        let camera_matrix: [f64; 16] = matrix.try_into().expect("a matrix of sixteen doubles");
        let (_, changed) = self.grid.resolve(&FrameInput {
            camera_matrix,
            flat: FlatRenderState { pan: [pan_x, pan_y], render_map_size },
            globe: on_globe.then_some((GlobeUniform { pan_x: globe_pan_x, pan_y: globe_pan_y, radius, transition }, [eye_x, eye_y, eye_z])),
            centre: [centre_x, centre_y],
            camera_zoom,
            viewport_height_points,
            tile_world_size,
        });
        if changed {
            self.write_header();
        }
        changed
    }

    /// Lays the texts of the last frame's tiles out again, once the tiles asked for are answered. Returns the number of glyphs.
    #[wasm_bindgen(js_name = layOutLabels)]
    pub fn lay_out_labels(&mut self) -> usize {
        let count = self.grid.lay_out_labels();
        self.write_header();
        count
    }

    fn write_header(&mut self) {
        let frame = *self.grid.frame();
        let grid = &self.grid;
        *self.header = [
            frame.resolution.map_or(0, |resolution| resolution.zoom as u32 + 1),
            frame.resolution.is_some_and(|resolution| resolution.draws_labels) as u32,
            frame.plain_count as u32,
            frame.selected_count as u32,
            frame.other_count as u32,
            frame.grid_subdivision,
            frame.other_subdivision,
            (grid.glyphs().len() / map_frame::tile_grid::GLYPH_WORDS) as u32,
            (grid.label_misses().len() / 3) as u32,
            grid.instances().as_ptr() as u32,
            grid.tiles().as_ptr() as u32,
            grid.glyphs().as_ptr() as u32,
            grid.label_misses().as_ptr() as u32,
            0,
            0,
            0,
        ];
    }
}
