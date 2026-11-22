// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { done, fail, fixtureBytes, manifest, publish, stat } from "./harness.ts";

async function run() {
  const { tiles } = await manifest();
  const compressed = await Promise.all(tiles.map((t) => fixtureBytes(t.file)));
  const bytes = compressed.reduce((s, b) => s + b.length, 0);
  const inflated = compressed.reduce((s, b) => s + new DataView(b.buffer).getUint32(b.length - 4, true), 0);
  const passes = Number(new URLSearchParams(location.search).get("passes") ?? 30);
  const worker = new Worker(new URL("./inflate-worker.ts", import.meta.url), { type: "module" });
  const times = await new Promise<Record<string, number[]>>((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage({ tiles: compressed, passes });
  });
  const rows = Object.entries(times).map(([name, samples]) => {
    const s = stat(samples);
    return [name, s.median, s.p95, (s.median / (inflated / 1e6)), s.median / tiles.length];
  });
  publish(
    `B2: inflate ${tiles.length} tiles (${(bytes / 1e6).toFixed(1)} MB gzip, ${(inflated / 1e6).toFixed(1)} MB inflated) in a worker`,
    ["path", "set ms (median)", "set ms (p95)", "ms per inflated MB", "ms per tile"],
    rows,
    times,
  );
  done();
}

run().catch(fail);
