// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// `trace=1`: records what a person does and what the map did about it, to
// chase a gesture or a stutter that a scripted browser does not reproduce.
// Kept: the pointer and wheel events on the map, every frame (the gap since
// the last one, its CPU and GPU time, the camera, the tiles loading), every
// animation frame of the browser (so a frame the map skipped shows), the
// main thread's long tasks, and the tiles that landed. Every two seconds the
// record goes to the dev server (`/__trace`, written to fixtures/trace.json).

import type { ImmersiveMap } from "@immersive-map/web";

export function addTraceRecorder(map: ImmersiveMap): void {
  const degrees = 180 / Math.PI;
  const events: unknown[] = [];
  const push = (kind: string, fields: Record<string, unknown>) => events.push({ kind, t: +performance.now().toFixed(1), ...fields });
  const canvas = document.querySelector("#map canvas") as HTMLCanvasElement;
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "contextmenu", "wheel", "mouseleave", "blur"] as const) {
    const target: EventTarget = type === "blur" ? window : canvas;
    target.addEventListener(
      type,
      (event) => {
        const e = event as PointerEvent & WheelEvent;
        push(type, { x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, alt: e.altKey, ctrl: e.ctrlKey, pointerType: e.pointerType, dy: e.deltaY, coalesced: typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents().length : undefined });
      },
      { capture: true, passive: true },
    );
  }
  let lastFrame = performance.now();
  // The map's device, to learn when the GPU finished each frame: a frame done
  // later than a refresh after its start reaches the screen a refresh late.
  const device = (map as unknown as { renderer: { gpu: { device: GPUDevice } } | null }).renderer?.gpu.device;
  map.onFrame((frame) => {
    const now = performance.now();
    const view = map.view;
    const started = now - frame.cpuMilliseconds;
    void device?.queue.onSubmittedWorkDone().then(() => push("gpuDone", { frame: frame.frameNumber, sinceStart: +(performance.now() - started).toFixed(1) }));
    push("frame", { n: frame.frameNumber, gap: +(now - lastFrame).toFixed(1), cpu: +frame.cpuMilliseconds.toFixed(2), gpu: frame.gpuMilliseconds === undefined ? undefined : +frame.gpuMilliseconds.toFixed(2), pitch: +(view.pitch * degrees).toFixed(2), bearing: +(view.bearing * degrees).toFixed(2), zoom: +view.zoom.toFixed(3), loading: frame.loadingTiles, visible: frame.visibleTiles });
    lastFrame = now;
  });
  let lastRaf = performance.now();
  // The browser's own refresh rate, counted over each second: 60 or 120 says what the display allows.
  let rafCount = 0;
  let rafWindowStart = performance.now();
  const raf = () => {
    const now = performance.now();
    rafCount += 1;
    if (now - rafWindowStart >= 1000) {
      push("refreshRate", { perSecond: +((rafCount * 1000) / (now - rafWindowStart)).toFixed(1) });
      rafCount = 0;
      rafWindowStart = now;
    }
    // Only the late ones: a refresh the browser itself missed.
    if (now - lastRaf > 25) push("lateRaf", { gap: +(now - lastRaf).toFixed(1) });
    lastRaf = now;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) push("longtask", { start: +entry.startTime.toFixed(1), duration: +entry.duration.toFixed(1) });
    }).observe({ type: "longtask" });
  } catch {
    // No long task timing in this browser.
  }
  map.onTileLoaded((tile) => push("tile", { megabytes: +(tile.gpuBytes / 1e6).toFixed(2), parse: tile.parseMilliseconds }));
  const environment = { userAgent: navigator.userAgent, devicePixelRatio, width: innerWidth, height: innerHeight, url: location.href };
  setInterval(() => {
    void fetch("/__trace", { method: "POST", body: JSON.stringify({ environment, events }) }).catch(() => undefined);
  }, 2000);
  const badge = document.createElement("div");
  badge.textContent = "trace recording";
  badge.style.cssText = "position:fixed;left:12px;bottom:12px;padding:4px 8px;background:#c33;color:#fff;font:12px sans-serif;border-radius:6px;z-index:10";
  document.body.append(badge);
}
