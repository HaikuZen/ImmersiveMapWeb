// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the road label placement (`map_frame::road_labels`). A
//! tile record's geometry is registered once and stays in Wasm memory, so a
//! frame's call carries the camera alone, and the placement is read back
//! from the module's memory at the addresses given. The TypeScript side is
//! packages/immersive-map/src/labels/road/road-label-placer.ts.

use map_frame::road_labels::{PointLifts, RoadLabelFrame, RoadLabelGeometry, RoadLabelPlacement, RoadLabelScratch, place, place_projected, project};
use wasm_bindgen::prelude::*;

#[derive(Default)]
struct Record {
    geometry: RoadLabelGeometry,
    /// The terrain's metres under the path points, empty off the relief.
    lifts: Vec<f32>,
    placement: RoadLabelPlacement,
}

/// The records' geometry and each one's last placement.
#[wasm_bindgen]
#[derive(Default)]
pub struct RoadLabelPlacer {
    records: Vec<Option<Record>>,
    free: Vec<u32>,
    scratch: RoadLabelScratch,
}

#[wasm_bindgen]
impl RoadLabelPlacer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> RoadLabelPlacer {
        RoadLabelPlacer::default()
    }

    /// A record's geometry, copied in once (`RoadLabelGeometry` states the arrays). Returns its handle.
    #[allow(clippy::too_many_arguments)]
    pub fn register(&mut self, path_points: &[f32], path_ranges: &[i32], path_instance_ranges: &[i32], anchors: &[i32], instance_glyph_ranges: &[i32], glyphs: &[f32], glyph_half_sizes: &[f32], glyph_count: usize) -> u32 {
        let mut record = Record {
            geometry: RoadLabelGeometry {
                path_points: path_points.to_vec(),
                path_ranges: path_ranges.to_vec(),
                path_instance_ranges: path_instance_ranges.to_vec(),
                anchors: anchors.to_vec(),
                instance_glyph_ranges: instance_glyph_ranges.to_vec(),
                glyphs: glyphs.to_vec(),
                glyph_half_sizes: glyph_half_sizes.to_vec(),
                glyph_count,
            },
            ..Record::default()
        };
        record.placement.resize(glyph_count);
        match self.free.pop() {
            Some(handle) => {
                self.records[handle as usize] = Some(record);
                handle
            }
            None => {
                self.records.push(Some(record));
                self.records.len() as u32 - 1
            }
        }
    }

    /// Forgets a record: its handle is given to a later one.
    pub fn unregister(&mut self, handle: u32) {
        if let Some(slot) = self.records.get_mut(handle as usize)
            && slot.take().is_some()
        {
            self.free.push(handle);
        }
    }

    /// How many records are registered.
    #[wasm_bindgen(getter, js_name = recordCount)]
    pub fn record_count(&self) -> usize {
        self.records.len() - self.free.len()
    }

    /// The terrain's metres under a record's path points, copied in when its terrain changes.
    #[wasm_bindgen(js_name = setLifts)]
    pub fn set_lifts(&mut self, handle: u32, metres: &[f32]) {
        if let Some(Some(record)) = self.records.get_mut(handle as usize) {
            record.lifts.clear();
            record.lifts.extend_from_slice(metres);
        }
    }

    /// Projects a record's paths and places its glyphs. `matrix` is the
    /// projection-view matrix, the origin the record's tile in render units,
    /// and the lifts given by `setLifts` are read only with `use_lifts`.
    #[allow(clippy::too_many_arguments)]
    pub fn place(&mut self, handle: u32, matrix: &[f64], origin_x: f64, origin_y: f64, size: f64, viewport_width: f64, viewport_height: f64, pixels_per_point: f64, maximum_depth: f64, use_lifts: bool, datum_metres: f64, units_per_metre: f64) {
        let Some(Some(record)) = self.records.get_mut(handle as usize) else { return };
        let projection_view: &[f64; 16] = matrix.try_into().expect("a matrix of sixteen doubles");
        let frame = RoadLabelFrame { projection_view, viewport_width, viewport_height, pixels_per_point };
        let lifts = use_lifts.then_some(PointLifts { metres: &record.lifts, datum_metres, units_per_metre });
        place(&record.geometry, [origin_x, origin_y, size], &frame, maximum_depth, lifts, &mut self.scratch, &mut record.placement);
    }

    /// Places a record's glyphs from points projected already, two doubles each, with a visibility byte per point.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = placeProjected)]
    pub fn place_projected(&mut self, handle: u32, points: &[f64], visible: &[u8], pixels_per_point: f64, viewport_width: f64, viewport_height: f64) {
        let Some(Some(record)) = self.records.get_mut(handle as usize) else { return };
        place_projected(&record.geometry, points, visible, pixels_per_point, viewport_width, viewport_height, &mut self.scratch, &mut record.placement);
    }

    /// Where a record's placements are in the module's memory: four floats a glyph.
    #[wasm_bindgen(js_name = placementsPtr)]
    pub fn placements_ptr(&self, handle: u32) -> *const f32 {
        self.records[handle as usize].as_ref().map_or(std::ptr::null(), |record| record.placement.placements.as_ptr())
    }

    /// Where a record's extrapolated flags are: a byte a glyph.
    #[wasm_bindgen(js_name = extrapolatedPtr)]
    pub fn extrapolated_ptr(&self, handle: u32) -> *const u8 {
        self.records[handle as usize].as_ref().map_or(std::ptr::null(), |record| record.placement.extrapolated.as_ptr())
    }

    /// Where a record's rotated box half sizes are: two floats a glyph.
    #[wasm_bindgen(js_name = boxHalfSizesPtr)]
    pub fn box_half_sizes_ptr(&self, handle: u32) -> *const f32 {
        self.records[handle as usize].as_ref().map_or(std::ptr::null(), |record| record.placement.box_half_sizes.as_ptr())
    }
}

/// The flat projection of tile points: x, y in device pixels and a
/// visibility flag for each, three doubles a point. `lift_metres` raises the
/// points when it holds one height a point.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = projectRoadLabelPoints)]
pub fn project_road_label_points(path_points: &[f32], origin_x: f64, origin_y: f64, size: f64, matrix: &[f64], viewport_width: f64, viewport_height: f64, maximum_depth: f64, lift_metres: &[f32], datum_metres: f64, units_per_metre: f64) -> Vec<f64> {
    let projection_view: &[f64; 16] = matrix.try_into().expect("a matrix of sixteen doubles");
    let frame = RoadLabelFrame { projection_view, viewport_width, viewport_height, pixels_per_point: 1.0 };
    let mut scratch = RoadLabelScratch::default();
    let lifts = (!lift_metres.is_empty()).then_some(PointLifts { metres: lift_metres, datum_metres, units_per_metre });
    project(path_points, [origin_x, origin_y, size], &frame, maximum_depth, lifts, &mut scratch);
    let count = path_points.len() / 2;
    (0..count).flat_map(|index| [scratch.screen_points[index * 2], scratch.screen_points[index * 2 + 1], scratch.visible[index] as f64]).collect()
}
