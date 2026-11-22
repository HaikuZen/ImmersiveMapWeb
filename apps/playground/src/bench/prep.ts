// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { done, fail, fixtureBytes, gunzip, manifest, publish, stat } from "./harness.ts";

async function run() {
  const { tiles } = await manifest();
  const loaded = await Promise.all(
    tiles.map(async (t) => ({ set: t.set, z: t.z, bytes: await gunzip(await fixtureBytes(t.file)) })),
  );
  const passes = Number(new URLSearchParams(location.search).get("passes") ?? 30);
  const worker = new Worker(new URL("./prep-worker.ts", import.meta.url), { type: "module" });
  const result = await new Promise<{ rustTimes: number[][]; tsTimes: number[][]; mismatches: string[] }>((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage({ tiles: loaded, passes, warmup: 5 });
  });

  // Per set: the sum over its tiles of each tile's median, and the heaviest tile.
  const sets = [...new Set(loaded.map((t) => t.set))];
  const rows: (string | number)[][] = [];
  let rustTotal = 0;
  let tsTotal = 0;
  for (const set of sets) {
    const idx = loaded.flatMap((t, i) => (t.set === set ? [i] : []));
    const r = idx.map((i) => stat(result.rustTimes[i]!));
    const s = idx.map((i) => stat(result.tsTimes[i]!));
    const rSum = r.reduce((a, v) => a + v.median, 0);
    const sSum = s.reduce((a, v) => a + v.median, 0);
    rustTotal += rSum;
    tsTotal += sSum;
    const kb = idx.reduce((a, i) => a + loaded[i]!.bytes.length, 0) / 1024;
    rows.push([
      set,
      idx.length,
      kb,
      rSum / idx.length,
      sSum / idx.length,
      Math.max(...r.map((v) => v.p95)),
      Math.max(...s.map((v) => v.p95)),
      sSum / rSum,
    ]);
  }
  rows.push(["all", loaded.length, loaded.reduce((a, t) => a + t.bytes.length, 0) / 1024, rustTotal / loaded.length, tsTotal / loaded.length, 0, 0, tsTotal / rustTotal]);
  publish(
    "B1: ms per tile in a worker (median per tile, averaged over the set)",
    ["set", "tiles", "MVT KiB", "Rust/Wasm", "TypeScript", "Rust worst p95", "TS worst p95", "TS / Rust"],
    rows,
    { mismatches: result.mismatches, passes },
  );
  if (result.mismatches.length) publish("output mismatches", ["tile"], result.mismatches.map((m) => [m]), null);
  done();
}

run().catch(fail);
