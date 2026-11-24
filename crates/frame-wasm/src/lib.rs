// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The per-frame logic the main thread runs in Wasm, where the measurements
//! found it faster than TypeScript: the tile placement planner
//! (docs/benchmarks/B04-planner.md), the label collision solve
//! (docs/benchmarks/B04-labels.md) and the pin collision layout
//! (docs/benchmarks/B04-pins.md), and the frame's tile coverage. The logic is
//! the `map-frame` and `map-visibility` crates of ImmersiveMapCore, shared
//! with the other hosts, and this module is their binding to JavaScript.

pub mod collisions;
pub mod coverage;
pub mod pins;
pub mod planner;

pub use planner::plan_placements;
