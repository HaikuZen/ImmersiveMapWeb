// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { done, fail, publish, stat } from "./harness.ts";

const SIZES = [50_000, 200_000, 800_000, 2_000_000];
const PER_SIZE = 15;

function call(worker: Worker, message: unknown, transfer: Transferable[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => (e.data?.error ? reject(new Error(e.data.error)) : resolve(e.data));
    worker.postMessage(message, transfer);
  });
}

const fresh = () => new Worker(new URL("./storage-worker.ts", import.meta.url), { type: "module" });

function tiles(): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  let seed = 1;
  for (const size of SIZES)
    for (let i = 0; i < PER_SIZE; i++) {
      const bytes = new Uint32Array(size / 4);
      for (let k = 0; k < bytes.length; k++) bytes[k] = seed = (seed * 1664525 + 1013904223) >>> 0;
      out.push(bytes.buffer);
    }
  return out;
}

async function run() {
  const rounds = Number(new URLSearchParams(location.search).get("rounds") ?? 3);
  const writeTimes: Record<string, number[]> = {};
  const coldTimes: Record<string, number[]> = {};
  const warmTimes: Record<string, number[]> = {};
  const opens: Record<string, number[]> = {};
  const count = SIZES.length * PER_SIZE;
  for (let round = 0; round < rounds; round++) {
    for (const store of ["opfs-packed", "opfs-sync", "idb", "cache"]) {
      const writer = fresh();
      await call(writer, { type: "clear" });
      const data = tiles();
      (writeTimes[store] ??= []).push(...(await call(writer, { type: "write", store, tiles: data }, data)));
      writer.terminate();
      const readers = store === "opfs-sync" ? ["opfs-sync", "opfs-file"] : [store];
      for (const reader of readers) {
        const cold = fresh();
        const first = await call(cold, { type: "read", store: reader, count });
        if (first.bytes !== SIZES.reduce((a, s) => a + s, 0) * PER_SIZE) throw new Error(`${reader} read back ${first.bytes} bytes`);
        (coldTimes[reader] ??= []).push(...first.times);
        (opens[reader] ??= []).push(first.open);
        const warm = await call(cold, { type: "read", store: reader, count });
        (warmTimes[reader] ??= []).push(...warm.times);
        cold.terminate();
      }
    }
  }
  const mb = (SIZES.reduce((a, s) => a + s, 0) * PER_SIZE) / 1e6;
  const per = (t: number[]) => stat(t);
  publish(
    `B12: ${count} tiles (${mb.toFixed(0)} MB, 50 KB to 2 MB each), ms per tile, ${rounds} rounds`,
    ["store", "write median", "write p95", "cold read median", "cold read p95", "warm read median", "warm read p95", "open ms"],
    Object.keys(coldTimes).map((k) => {
      const w = writeTimes[k] ?? writeTimes["opfs-sync"]!;
      return [k, per(w).median, per(w).p95, per(coldTimes[k]!).median, per(coldTimes[k]!).p95, per(warmTimes[k]!).median, per(warmTimes[k]!).p95, per(opens[k]!).median];
    }),
    { writeTimes, coldTimes, warmTimes, opens },
  );
  const worker = fresh();
  await call(worker, { type: "clear" });
  worker.terminate();
  done();
}

run().catch(fail);
