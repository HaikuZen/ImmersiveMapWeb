// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The per-frame logic the main thread runs in Wasm, where the measurements
//! found it faster than TypeScript: the tile placement planner
//! (docs/benchmarks/B04-planner.md), the label collision solve
//! (docs/benchmarks/B04-labels.md) and the pin collision layout
//! (docs/benchmarks/B04-pins.md). The logic is the `map-frame` crate of
//! ImmersiveMapCore, shared with the other hosts, and this module is its
//! binding to JavaScript.

pub mod collisions;
pub mod pins;
pub mod planner;

pub use planner::plan_placements;
