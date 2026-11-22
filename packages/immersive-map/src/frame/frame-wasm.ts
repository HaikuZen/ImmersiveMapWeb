// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The main thread's Wasm module (crates/frame-wasm): the per-frame logic the
 * measurements found faster in Rust (docs/benchmarks/B04-planner.md). It is
 * initialised once, before the first frame, and its functions are then called
 * synchronously.
 */

import init from "../wasm/frame_wasm/frame_wasm.js";

let ready: Promise<void> | undefined;
let initialised = false;

/** Loads the module once. `source` is the module's bytes or URL, the package's own by default. */
export function initFrameWasm(source?: BufferSource | URL | string): Promise<void> {
  ready ??= init(source === undefined ? undefined : { module_or_path: source }).then(() => {
    initialised = true;
  });
  return ready;
}

export function assertFrameWasm(): void {
  if (!initialised) throw new Error("the frame Wasm module is not loaded: await initFrameWasm() before the first frame");
}
