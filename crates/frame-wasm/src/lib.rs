// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The per-frame logic the main thread runs in Wasm, where the measurements
//! found it faster than TypeScript: the tile placement planner, the label
//! collision solve, the pin collision layout, the frame's tile coverage and
//! the tile grid's frame. The logic is
//! the `map-frame` and `map-visibility` crates of ImmersiveMapCore, shared
//! with the other hosts, and this module is their binding to JavaScript.

pub mod collisions;
pub mod coverage;
pub mod pins;
pub mod planner;
pub mod road_labels;
pub mod tile_grid;

pub use planner::plan_placements;
