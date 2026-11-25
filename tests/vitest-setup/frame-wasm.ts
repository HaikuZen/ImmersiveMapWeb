// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Vitest setup: loads the frame Wasm module from disk before any test runs,
// as the map does before its first frame. `npm run build:wasm` writes it.

import { readFile } from "node:fs/promises";
import { initFrameWasm } from "../../packages/immersive-map/src/frame/frame-wasm.ts";

await initFrameWasm(await readFile(new URL("../../packages/immersive-map/src/wasm/frame_wasm/frame_wasm_bg.wasm", import.meta.url)));
