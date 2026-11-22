// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B17: tiles per second for the whole fixture set (inflated beforehand), with
// the same number of threads: N workers each with its own Wasm instance (the
// map's design, no SharedArrayBuffer), against one shared-memory instance with
// a rayon pool of N (wasm-bindgen-rayon, which needs COOP and COEP).

import { done, fail, fixtureBytes, manifest, publish, stat } from "./harness.ts";

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

async function run() {
  const { tiles } = await manifest();
  const inflated = await Promise.all(tiles.map(async (t) => ({ bytes: await inflate(await fixtureBytes(t.file)), z: t.z, x: t.x, y: t.y })));
  const passes = Number(new URLSearchParams(location.search).get("passes") ?? 8);
  const threads = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

  // The worker pool: tiles dealt round-robin, the set's time is the slowest worker's.
  const pool = await Promise.all(
    Array.from({ length: threads }, async () => {
      const worker = new Worker(new URL("./threads-pool-worker.ts", import.meta.url), { type: "module" });
      await new Promise<void>((resolve) => {
        worker.onmessage = () => resolve();
        worker.postMessage("init");
      });
      return worker;
    }),
  );
  const poolTimes: number[] = [];
  for (let pass = 0; pass < passes + 2; pass++) {
    const start = performance.now();
    await Promise.all(
      pool.map(
        (worker, w) =>
          new Promise<void>((resolve) => {
            worker.onmessage = () => resolve();
            worker.postMessage({ tiles: inflated.filter((_, i) => i % threads === w) });
          }),
      ),
    );
    if (pass >= 2) poolTimes.push(performance.now() - start);
  }
  pool.forEach((w) => w.terminate());

  const total = inflated.reduce((s, t) => s + t.bytes.length, 0);
  const bytes = new Uint8Array(total);
  const ends = new Uint32Array(inflated.length);
  const zxy = new Int32Array(inflated.length * 3);
  let at = 0;
  inflated.forEach((t, i) => {
    bytes.set(t.bytes, at);
    at += t.bytes.length;
    ends[i] = at;
    zxy.set([t.z, t.x, t.y], i * 3);
  });
  const rayonRun = async (poolSize: number) => {
    const rayon = new Worker(new URL("./threads-rayon-worker.ts", import.meta.url), { type: "module" });
    const times = await new Promise<number[]>((resolve, reject) => {
      rayon.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.times));
      rayon.onerror = (e) => reject(new Error(e.message));
      rayon.postMessage({ bytes, ends, zxy, threads: poolSize, passes });
    });
    rayon.terminate();
    return times;
  };
  const rayonTimes = await rayonRun(threads);
  // One thread: the shared-memory build's own cost, without the pool's contention.
  const rayonSingle = await rayonRun(1);

  const rows = [
    [`${threads} workers, a Wasm instance each`, stat(poolTimes)],
    [`one shared-memory instance, rayon pool of ${threads}`, stat(rayonTimes)],
    ["one shared-memory instance, rayon pool of 1", stat(rayonSingle)],
  ].map(([name, s]) => {
    const st = s as ReturnType<typeof stat>;
    return [name as string, st.median, st.p95, inflated.length / (st.median / 1000)];
  });
  publish(`B17: parse ${inflated.length} fixture tiles with ${threads} threads`, ["path", "set ms (median)", "p95", "tiles per second"], rows, { poolTimes, rayonTimes, rayonSingle });
  done();
}

run().catch(fail);
