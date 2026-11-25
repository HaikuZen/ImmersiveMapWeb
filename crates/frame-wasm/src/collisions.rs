// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the label collision solve (`map_frame::collisions`), the
//! engine's solver, which replaced the TypeScript one
//! (packages/immersive-map/src/labels/collisions/label-collision-solver.ts
//! is its adapter). Everything crosses the boundary as flat typed
//! arrays: the base ranks once per topology change, the boxes and the road
//! items every solve, the decisions back.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct LabelCollisionSolver {
    inner: map_frame::collisions::LabelCollisionSolver,
}

#[wasm_bindgen]
impl LabelCollisionSolver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> LabelCollisionSolver {
        LabelCollisionSolver::default()
    }

    /// The base labels' collision priorities in the working set's order, and their indices in rank order.
    #[wasm_bindgen(js_name = rebindBase)]
    pub fn rebind_base(&mut self, priority: &[i32], order: &[i32]) {
        self.inner.rebind_base(priority, order);
    }

    /// Solves one frame: the decisions are written into the two arrays.
    #[allow(clippy::too_many_arguments)]
    pub fn solve(
        &mut self,
        viewport_width: f32,
        viewport_height: f32,
        cell_size_px: f32,
        base_centers: &[f32],
        base_half_sizes: &[f32],
        base_enabled: &[u8],
        road_items: &[i32],
        road_centers: &[f32],
        road_half_sizes: &[f32],
        base_visible: &mut [u8],
        road_visible: &mut [u8],
    ) {
        self.inner.solve(viewport_width, viewport_height, cell_size_px, base_centers, base_half_sizes, base_enabled, road_items, road_centers, road_half_sizes, base_visible, road_visible);
    }
}
