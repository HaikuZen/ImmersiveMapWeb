// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Vitest setup: loads the layers' Wasm module (crates/layer-wasm) from disk
// before any test runs, as the layers' worker does before its first job, so
// the tests read GeoJSON and build meshes with the same Rust. `npm run
// build:wasm` writes it.

import { readFile } from "node:fs/promises";
import init from "../../packages/immersive-map/src/wasm/layer_wasm/layer_wasm.js";

await init({ module_or_path: await readFile(new URL("../../packages/immersive-map/src/wasm/layer_wasm/layer_wasm_bg.wasm", import.meta.url)) });
