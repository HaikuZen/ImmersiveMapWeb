// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The main thread's Wasm module (crates/frame-wasm): the per-frame logic the
 * measurements found faster in Rust. It is
 * initialised once, before the first frame, and its functions are then called
 * synchronously.
 */

import init from "../wasm/frame_wasm/frame_wasm.js";

let ready: Promise<void> | undefined;
let initialised = false;
let memory: WebAssembly.Memory | undefined;

/** Loads the module once. `source` is the module's bytes or URL, the package's own by default. */
export function initFrameWasm(source?: BufferSource | URL | string): Promise<void> {
  ready ??= init(source === undefined ? undefined : { module_or_path: source }).then((exports) => {
    memory = exports.memory;
    initialised = true;
  });
  return ready;
}

export function assertFrameWasm(): void {
  if (!initialised) throw new Error("the frame Wasm module is not loaded: await initFrameWasm() before the first frame");
}

/**
 * The module's memory, for reading a result where the module left it. Its
 * buffer is replaced when the memory grows, so a view over it is made for
 * the read at hand and not kept.
 */
export function frameWasmMemory(): WebAssembly.Memory {
  if (memory === undefined) throw new Error("the frame Wasm module is not loaded: await initFrameWasm() before the first frame");
  return memory;
}
