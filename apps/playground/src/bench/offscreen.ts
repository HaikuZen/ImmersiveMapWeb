// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B8: rendering on the main thread against rendering in a worker into an
// OffscreenCanvas. Each animation frame the main thread moves the camera and
// a DOM annotation with it (as the map's annotations follow the camera). On
// the main thread the frame is drawn in the same callback. In the worker it is
// drawn on the worker's next animation frame from the camera posted to it.
// Kept: the main thread's time per frame, and how many of the main thread's
// frames the canvas trails the annotation by.

import { createScene } from "./offscreen-scene.ts";
import { done, fail, publish, stat } from "./harness.ts";

const FRAMES = Number(new URLSearchParams(location.search).get("frames") ?? 300);
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1000;
  document.body.append(canvas);
  return canvas;
}

async function mainThread() {
  const canvas = makeCanvas();
  const annotation = document.createElement("div");
  document.body.append(annotation);
  const scene = await createScene(canvas);
  const main: number[] = [];
  for (let f = 0; f < FRAMES + 20; f++) {
    await nextFrame();
    const start = performance.now();
    annotation.style.transform = `translateX(${Math.sin(f * 0.05) * 100}px)`;
    scene.draw(f);
    if (f >= 20) main.push(performance.now() - start);
  }
  canvas.remove();
  annotation.remove();
  return { main, lag: main.map(() => 0) };
}

async function worker() {
  const canvas = makeCanvas();
  const annotation = document.createElement("div");
  document.body.append(annotation);
  const offscreen = canvas.transferControlToOffscreen();
  const w = new Worker(new URL("./offscreen-worker.ts", import.meta.url), { type: "module" });
  await new Promise<void>((resolve) => {
    w.onmessage = (e) => e.data === "ready" && resolve();
    w.postMessage({ canvas: offscreen }, [offscreen]);
  });
  const lag: number[] = [];
  const main: number[] = [];
  let frame = 0;
  // The main thread's frame count when a camera's canvas frame was drawn: its lag.
  w.onmessage = (e) => {
    if (typeof e.data === "object" && e.data.drawn >= 20) lag.push(frame - e.data.drawn);
  };
  for (; frame < FRAMES + 20; frame++) {
    await nextFrame();
    const start = performance.now();
    annotation.style.transform = `translateX(${Math.sin(frame * 0.05) * 100}px)`;
    w.postMessage({ camera: frame });
    if (frame >= 20) main.push(performance.now() - start);
  }
  await nextFrame();
  await nextFrame();
  w.terminate();
  canvas.remove();
  annotation.remove();
  return { main, lag };
}

async function run() {
  const a = await mainThread();
  const b = await worker();
  const rows = [
    ["main thread", stat(a.main), stat(a.lag), a.lag.length],
    ["worker + OffscreenCanvas", stat(b.main), stat(b.lag), b.lag.length],
  ].map(([name, m, l, n]) => {
    const ms = m as ReturnType<typeof stat>;
    const lg = l as ReturnType<typeof stat>;
    return [name as string, ms.median, ms.p95, lg.median, lg.p95, n as number];
  });
  publish("B8: main thread ms per frame, and the canvas's lag behind the DOM in frames", ["variant", "main ms (median)", "main ms (p95)", "lag frames (median)", "lag frames (p95)", "frames drawn"], rows, { a, b });
  done();
}

run().catch(fail);
