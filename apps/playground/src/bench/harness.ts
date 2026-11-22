// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The benchmark harness (docs/GOAL.md, section 4): fixed fixtures, warm-up,
// then many iterations, reported as median and p95. A page publishes its
// result on window.benchResults for scripts/bench.mjs to collect.

export interface Stat {
  median: number;
  p95: number;
  mean: number;
  min: number;
  n: number;
}

export function stat(samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    median: at(0.5),
    p95: at(0.95),
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    min: sorted[0]!,
    n: sorted.length,
  };
}

export async function measure(run: () => unknown, options: { warmup?: number; iterations?: number } = {}): Promise<Stat> {
  const { warmup = 10, iterations = 50 } = options;
  for (let i = 0; i < warmup; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return stat(samples);
}

export interface FixtureTile {
  set: string;
  z: number;
  x: number;
  y: number;
  file: string;
}

export interface Manifest {
  tiles: FixtureTile[];
  terrainTiles: FixtureTile[];
}

export async function manifest(): Promise<Manifest> {
  const response = await fetch("/fixtures/manifest.json");
  if (!response.ok) throw new Error("no fixtures: run `node scripts/fetch-fixtures.mjs`");
  return response.json();
}

export async function fixtureBytes(file: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(`/fixtures/${file}`);
  if (!response.ok) throw new Error(`fixture ${file}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function environment() {
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    cores: navigator.hardwareConcurrency,
  };
}

const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(3));

/** Renders rows into the page's table and publishes the result. */
export function publish(title: string, columns: string[], rows: (string | number)[][], raw: unknown): void {
  const table = document.createElement("table");
  table.innerHTML = `<caption>${title}</caption><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr>`;
  for (const row of rows) {
    const tr = table.insertRow();
    for (const cell of row) tr.insertCell().textContent = typeof cell === "number" ? fmt(cell) : cell;
  }
  document.body.append(table);
  const results = ((window as unknown as { benchResults?: unknown[] }).benchResults ??= []);
  results.push({ title, columns, rows, raw, environment: environment() });
}

export function done(): void {
  (window as unknown as { benchDone: boolean }).benchDone = true;
  document.getElementById("status")!.textContent = "done";
}

export function fail(error: unknown): void {
  (window as unknown as { benchError: string }).benchError = String(error);
  document.getElementById("status")!.textContent = `failed: ${String(error)}`;
}
