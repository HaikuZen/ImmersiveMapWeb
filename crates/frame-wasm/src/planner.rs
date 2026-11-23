// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the tile placement planner (`map_frame::planner`, whose
//! comment states the records; the TypeScript adapter is
//! packages/immersive-map/src/tile/placement/tile-placement-planner.ts,
//! which states the rules). Everything crosses the boundary as flat
//! Int32Arrays. On the relief the terrain a tile is placed with comes from
//! two JS functions, asked only when the relief is on.

use map_frame::planner::{Relief, T, plan_flat};
use wasm_bindgen::prelude::*;

/// The relief's two questions asked of JavaScript.
struct JsRelief<'a> {
    terrain: &'a js_sys::Function,
    terrain_resident: &'a js_sys::Function,
}

impl Relief for JsRelief<'_> {
    fn terrain(&mut self, tile: T, slot_zoom: i32) -> Option<(T, T)> {
        let answer = self.terrain.call4(&JsValue::NULL, &tile.z.into(), &tile.x.into(), &tile.y.into(), &slot_zoom.into()).ok()?;
        let array: js_sys::Int32Array = answer.dyn_into().ok()?;
        if array.length() < 6 {
            return None;
        }
        let v = array.to_vec();
        Some((T { z: v[0], x: v[1], y: v[2] }, T { z: v[3], x: v[4], y: v[5] }))
    }
    fn terrain_resident(&mut self, tile: T) -> bool {
        self.terrain_resident.call3(&JsValue::NULL, &tile.z.into(), &tile.x.into(), &tile.y.into()).ok().and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

/// The binding. `backdrop_zoom` and `descendant_search_depth` are -1 for none
/// and for unbounded. `terrain(z, x, y, slotZoom)` returns an Int32Array of
/// six (terrain, displacement) or undefined, `terrain_resident(z, x, y)` a
/// boolean: both are passed only on the relief.
#[wasm_bindgen(js_name = planPlacements)]
pub fn plan_placements(
    targets: &[i32],
    resident: &[i32],
    previous: &[i32],
    backdrop_zoom: i32,
    descendant_search_depth: i32,
    terrain: Option<js_sys::Function>,
    terrain_resident: Option<js_sys::Function>,
) -> Vec<i32> {
    match (&terrain, &terrain_resident) {
        (Some(t), Some(r)) => plan_flat(targets, resident, previous, backdrop_zoom, descendant_search_depth, Some(&mut JsRelief { terrain: t, terrain_resident: r })),
        _ => plan_flat(targets, resident, previous, backdrop_zoom, descendant_search_depth, None),
    }
}
