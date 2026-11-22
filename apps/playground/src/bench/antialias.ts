// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B16: the map's whole frame on the GPU (timestamp-query from its first
// pass's start to its last pass's end) with no antialiasing, MSAA 4x, FXAA,
// and both, over the same view: lower Manhattan from the README's camera,
// on the local fixture archive (no network), with its buildings, shadows
// and trees. Each variant is a map of its own (the sample count rebuilds
// the renderer), settled first, then driven frame after frame.
// `?only=<variant>` builds one variant and stays, for a screenshot.

import { ImmersiveMap, ImmersiveMapSettings, type FrameEvent } from "@artembobkin/immersive-map";
import { done, fail, publish, stat } from "./harness.ts";

const variants: [string, (s: ImmersiveMapSettings) => ImmersiveMapSettings][] = [
  ["none", (s) => s],
  ["msaa4x", (s) => s.msaa({ isEnabled: true })],
  ["fxaa", (s) => s.fxaa({ isEnabled: true })],
  ["msaa4x+fxaa", (s) => s.msaa({ isEnabled: true }).fxaa({ isEnabled: true })],
];

const params = new URLSearchParams(location.search);
const frames = Number(params.get("frames") ?? 200);
const only = params.get("only");

async function measureVariant(name: string, configure: (s: ImmersiveMapSettings) => ImmersiveMapSettings) {
  const container = document.getElementById("map")!;
  const settings = configure(ImmersiveMapSettings.default.globe({ isEnabled: false }));
  const map = await ImmersiveMap.create({
    container,
    settings,
    url: "/fixtures/fixtures.pmtiles",
    camera: { center: [-74.011, 40.715], zoom: 15.01, pitch: (50.48 * Math.PI) / 180, bearing: (-60.79 * Math.PI) / 180 },
  });
  let last: FrameEvent | undefined;
  let lastFrameAt = performance.now();
  map.onFrame((event) => {
    last = event;
    lastFrameAt = performance.now();
  });
  // Settled: tiles in, none loading, a second without a frame.
  const started = performance.now();
  while (!(last && last.visibleTiles > 0 && last.loadingTiles === 0 && performance.now() - lastFrameAt > 1000) && performance.now() - started < 60_000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  (window as unknown as { mapSettle: object }).mapSettle = { visible: last?.visibleTiles ?? 0, loading: 0, lastFrame: 0 };
  if (only) return undefined;
  const gpu: number[] = [];
  let previous: number | undefined;
  for (let f = 0; f < frames + 20; f++) {
    map.requestFrame();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const ms = last?.gpuMilliseconds;
    // A reading changes only when the GPU's timing buffer was read back.
    if (f >= 20 && ms !== undefined && ms !== previous) gpu.push(ms);
    previous = ms;
  }
  map.destroy();
  return stat(gpu);
}

async function run() {
  if (only) {
    const variant = variants.find(([name]) => name === only);
    if (!variant) throw new Error(`no variant ${only}`);
    await measureVariant(...variant);
    done();
    return;
  }
  const rows: (string | number)[][] = [];
  const raw: unknown[] = [];
  for (const [name, configure] of variants) {
    const s = (await measureVariant(name, configure))!;
    rows.push([name, s.median, s.p95, s.n]);
    raw.push({ variant: name, gpu: s });
  }
  publish("B16: GPU ms per frame, lower Manhattan z15, 1200x860 CSS px", ["antialiasing", "GPU median ms", "GPU p95 ms", "frames"], rows, raw);
  done();
}

run().catch(fail);
