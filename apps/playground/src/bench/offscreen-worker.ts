// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B8, the worker side: the scene drawn into a transferred OffscreenCanvas on
// the worker's own animation frames, with the newest camera the main thread sent.

import { createScene, type Scene } from "./offscreen-scene.ts";

declare const self: DedicatedWorkerGlobalScope;

let scene: Scene | undefined;
let camera = -1;
let drawn = -1;

self.onmessage = async (event: MessageEvent<{ canvas: OffscreenCanvas } | { camera: number }>) => {
  if ("canvas" in event.data) {
    scene = await createScene(event.data.canvas);
    const tick = () => {
      if (camera !== drawn) {
        const start = performance.now();
        scene!.draw(camera);
        drawn = camera;
        self.postMessage({ drawn: camera, workerMs: performance.now() - start });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    self.postMessage("ready");
    return;
  }
  camera = event.data.camera;
};
