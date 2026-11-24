// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the frame's tile coverage (`map_visibility`): which tiles
//! a camera pose draws, at which zooms, on the plane and on the sphere. One
//! call a frame resolves it, and the targets, the bands and the walk's
//! counts are read back as flat arrays. The TypeScript side is
//! packages/immersive-map/src/tile/visibility/tile-culling.ts.

use map_visibility::culling::{TileCulling, VisibleContent};
use map_visibility::flat::FlatCoverageInput;
use map_visibility::frustum::Frustum;
use map_visibility::globe::{self, GlobeCoverageInput, GlobeUniform};
use map_visibility::polygon::footprint;
use map_visibility::rules::FlatRingRule;
use map_visibility::FlatRenderState;
use wasm_bindgen::prelude::*;

/// Doubles per rule: zoom drop, distance, lines, labels, raster size (-1 for none), terrain zoom drop.
const RULE_STRIDE: usize = 6;

/// The coverage of frame after frame, with the version that moves when it changes.
#[wasm_bindgen]
#[derive(Default)]
pub struct TileCoverage {
    culling: TileCulling,
    rules: Vec<FlatRingRule>,
    content: VisibleContent,
}

#[wasm_bindgen]
impl TileCoverage {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TileCoverage {
        TileCoverage::default()
    }

    /// The ring rules of the frames that follow, `RULE_STRIDE` doubles each.
    #[wasm_bindgen(js_name = setRules)]
    pub fn set_rules(&mut self, rules: &[f64]) {
        self.rules = rules
            .as_chunks::<RULE_STRIDE>()
            .0
            .iter()
            .map(|r| FlatRingRule { zoom_drop: r[0] as i32, distance: r[1], draws_lines: r[2] != 0.0, draws_labels: r[3] != 0.0, raster_size: (r[4] >= 0.0).then_some(r[4] as u32), terrain_zoom_drop: r[5] as i32 })
            .collect();
    }

    /// The frame's coverage on the plane. `matrix` is the projection-view
    /// matrix, sixteen doubles, all zero for a frame with none. The relief's
    /// heights are read only with `has_heights`. `backdrop_zoom` is -1 for
    /// none. Returns the number of targets.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = resolveFlat)]
    pub fn resolve_flat(&mut self, matrix: &[f64], has_heights: bool, lowest: f64, highest: f64, eye_x: f64, eye_y: f64, raster_band_margin_share: f64, pan_x: f64, pan_y: f64, render_map_size: f64, target_zoom: i32, backdrop_zoom: i32) -> usize {
        let camera_matrix: &[f64; 16] = matrix.try_into().expect("a matrix of sixteen doubles");
        self.content = self.culling.resolve_flat(&FlatCoverageInput {
            camera_matrix,
            relief_heights: has_heights.then_some((lowest, highest)),
            eye: [eye_x, eye_y],
            raster_band_margin_share,
            flat: FlatRenderState { pan: [pan_x, pan_y], render_map_size },
            target_zoom,
            backdrop_zoom: (backdrop_zoom >= 0).then_some(backdrop_zoom),
            rules: &self.rules,
        });
        self.content.targets.len()
    }

    /// The frame's coverage on the sphere. `planes` is the frustum's six
    /// planes, twenty-four doubles, and the centre is the point the camera
    /// looks at in fractional tiles of the target zoom. Returns the number of
    /// targets.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = resolveGlobe)]
    pub fn resolve_globe(&mut self, planes: &[f64], eye_x: f64, eye_y: f64, eye_z: f64, pan_x: f64, pan_y: f64, radius: f64, transition: f64, center_tile_x: f64, center_tile_y: f64, target_zoom: i32) -> usize {
        let frustum = Frustum { planes: planes.try_into().expect("six planes of four doubles") };
        self.content = self.culling.resolve_globe(&GlobeCoverageInput {
            eye: [eye_x, eye_y, eye_z],
            globe: GlobeUniform { pan_x, pan_y, radius, transition },
            rules: &self.rules,
            look_at: globe::look_at_tile([center_tile_x, center_tile_y], target_zoom),
            target_zoom,
            frustum: &frustum,
        });
        self.content.targets.len()
    }

    /// The last coverage's targets, finest first, seven ints each: z, x, y,
    /// the world copy, lines, labels, the raster's size (-1 for none).
    pub fn targets(&self) -> Vec<i32> {
        let mut out = Vec::new();
        self.content.write_targets(&mut out);
        out
    }

    /// The last coverage's bands, nearest first, four doubles each: the zoom, the last ring, the tile count, the terrain's zoom.
    pub fn bands(&self) -> Vec<f64> {
        self.content.bands.iter().flat_map(|band| [band.zoom as f64, band.distance, band.tile_count as f64, band.terrain_zoom as f64]).collect()
    }

    /// Moves when the targets or their rasters differ from the frame before.
    #[wasm_bindgen(getter, js_name = coverageVersion)]
    pub fn coverage_version(&self) -> u32 {
        self.content.coverage_version
    }

    /// The last walk's counts, for the diagnostics: the tiles looked at,
    /// then the sphere's frustum rejects, horizon rejects, placed tiles and
    /// subtrees accepted whole (zero on the plane).
    pub fn metrics(&self) -> Vec<u32> {
        let globe = &self.content.globe_metrics;
        vec![self.content.visited as u32, globe.frustum_rejects as u32, globe.horizon_rejects as u32, globe.placed_tiles as u32, globe.accepted_whole_subtrees as u32]
    }
}

/// The frustum's footprint on the flat plane as x and y pairs, empty for a
/// camera with none. `matrix` is the projection-view matrix. The debug
/// overlay draws it.
#[wasm_bindgen(js_name = coverageFootprint)]
pub fn coverage_footprint(matrix: &[f64]) -> Vec<f64> {
    let Ok(camera_matrix) = <&[f64; 16]>::try_from(matrix) else { return Vec::new() };
    footprint(camera_matrix, None).map_or_else(Vec::new, |polygon| polygon.vertices().iter().flatten().copied().collect())
}
