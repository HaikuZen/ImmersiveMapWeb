// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B9: decoding the relief's height tiles (Mapterhorn, Terrarium-encoded WebP,
// 512 x 512) in a worker, three ways, with the heights checked against the
// exact decode.

import { done, fail, fixtureBytes, manifest, publish, stat } from "./harness.ts";

async function run() {
  const all = (await manifest()) as unknown as { terrainTiles: { file: string; z: number }[] };
  const tiles = await Promise.all(all.terrainTiles.map((t) => fixtureBytes(t.file)));
  const passes = Number(new URLSearchParams(location.search).get("passes") ?? 15);
  const worker = new Worker(new URL("./terrain-worker.ts", import.meta.url), { type: "module" });
  const { times, errors } = await new Promise<{ times: Record<string, number[]>; errors: Record<string, number> }>((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage({ tiles, passes });
  });
  const rows = Object.entries(times).map(([name, samples]) => {
    const s = stat(samples);
    return [name, s.median, s.p95, errors[name]!];
  });
  publish(`B9: ms per terrain tile, ${tiles.length} tiles, in a worker`, ["path", "ms per tile (median)", "p95", "max height error, m"], rows, { times, errors });
  done();
}

run().catch(fail);
