// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the pin collision layout (`map_frame::pins`), the
//! engine's solver after benchmark B4 (pins, docs/benchmarks/B04-pins.md).
//! It is built with the `js-math` feature, so its transcendental functions
//! are the JS engine's own and the layout matches the TypeScript port kept
//! for the benchmark (apps/playground/src/bench/
//! ts-pin-collision-layout-solver.ts) bit for bit. Everything crosses the
//! boundary as flat `f64` arrays: the pins in, the items and the flowers out.

use wasm_bindgen::prelude::*;

/// The pin collision layout solver with its inter-frame state.
#[wasm_bindgen]
#[derive(Default)]
pub struct PinCollisionSolver {
    inner: map_frame::pins::PinCollisionSolver,
}

#[wasm_bindgen]
impl PinCollisionSolver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Forgets the inter-frame state.
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Solves one frame: `pins` holds `PIN_INPUT_STRIDE` doubles per pin.
    /// Returns the header, the items in draw order (`PIN_ITEM_STRIDE`
    /// doubles each) and the flowers (center x, center y, member count,
    /// visible count, member input indices, visible input indices).
    #[allow(clippy::too_many_arguments)]
    pub fn solve(
        &mut self,
        pins: &[f64],
        pin_size_px: f64,
        body_radius_px: f64,
        circle_body_radius_px: f64,
        body_center_offset_x: f64,
        body_center_offset_y: f64,
        compressed_scale: f64,
        collision_padding_px: f64,
        grouping_threshold: f64,
        max_offset_px: f64,
        collision_iterations: f64,
        spring_k: f64,
        smoothing: f64,
        time: f64,
    ) -> Vec<f64> {
        self.inner.solve(
            pins,
            pin_size_px,
            body_radius_px,
            circle_body_radius_px,
            body_center_offset_x,
            body_center_offset_y,
            compressed_scale,
            collision_padding_px,
            grouping_threshold,
            max_offset_px,
            collision_iterations,
            spring_k,
            smoothing,
            time,
        )
    }
}
