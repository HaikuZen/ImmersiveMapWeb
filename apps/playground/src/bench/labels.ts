// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B4 (labels): the frame's label collision solve in TypeScript (the port
// kept here, ts-label-collision-solver.ts) against the same solver in
// Rust/Wasm on the main thread (crates/frame-wasm/src/collisions.rs) through
// the engine's adapter (LabelCollisionSolver), the Wasm path paying the
// copies a frame would: the boxes, the switches and the road items in, the
// decisions out. The base ranks cross once, as at a topology change.
//
// The scenes are a 2560 by 1600 drawable (a 1280 by 800 window at 2x) with
// 1 000 and 10 000 base labels of the sizes the tiles carry (names of 40 to
// 240 by 24 to 44 pixels, the 16 point grid at 2x) and one road name per 40
// labels, 6 to 14 glyphs along a gentle curve. Positions and ranks come from
// a fixed seed, so every run solves the same frames.

import { initFrameWasm } from "../../../../packages/immersive-map/src/frame/frame-wasm.ts";
import { LabelCollisionRoadItems, LabelCollisionSolver as WasmSolver } from "../../../../packages/immersive-map/src/labels/collisions/label-collision-solver.ts";
import { LabelCollisionSolver as TsSolver } from "./ts-label-collision-solver.ts";
import { done, fail, publish, stat } from "./harness.ts";

const WIDTH = 2560;
const HEIGHT = 1600;
const CELL = 32;

interface Scene {
  name: string;
  priority: Int32Array;
  order: Int32Array;
  centers: Float32Array;
  halves: Float32Array;
  enabled: Uint8Array;
  roadItems: LabelCollisionRoadItems;
  roadCenters: Float32Array;
  roadHalves: Float32Array;
  roadBoxCount: number;
  roadInstanceCount: number;
}

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scene(count: number, seed: number): Scene {
  const next = random(seed);
  const priority = new Int32Array(count);
  const centers = new Float32Array(count * 2);
  const halves = new Float32Array(count * 2);
  const enabled = new Uint8Array(count).fill(1);
  for (let i = 0; i < count; i++) {
    priority[i] = Math.floor(next() * 200);
    // A little past the drawable on every side, as a tilted frame's labels lie.
    centers[i * 2] = next() * (WIDTH + 200) - 100;
    centers[i * 2 + 1] = next() * (HEIGHT + 200) - 100;
    halves[i * 2] = 20 + next() * 100;
    halves[i * 2 + 1] = 12 + next() * 10;
    if (next() < 0.1) enabled[i] = 0;
  }
  const order = Int32Array.from({ length: count }, (_, i) => i).sort((a, b) => priority[a]! - priority[b]! || a - b);
  const roadItems = new LabelCollisionRoadItems();
  const roadCenters: number[] = [];
  const roadHalves: number[] = [];
  const instances = Math.max(1, Math.floor(count / 40));
  for (let r = 0; r < instances; r++) {
    const glyphs = 6 + Math.floor(next() * 9);
    let x = next() * WIDTH;
    let y = next() * HEIGHT;
    let angle = next() * Math.PI * 2;
    const start = roadCenters.length / 2;
    for (let g = 0; g < glyphs; g++) {
      roadCenters.push(x, y);
      roadHalves.push(9, 14);
      angle += (next() - 0.5) * 0.2;
      x += Math.cos(angle) * 18;
      y += Math.sin(angle) * 18;
    }
    roadItems.push(1_000_000_000, Math.floor(next() * 2) * 1024 + r, r, r % 30, Math.floor(next() * 2 ** 32), Math.floor(next() * 2 ** 32), start, roadCenters.length / 2, r);
  }
  return {
    name: `${count} labels, ${instances} road names`,
    priority,
    order,
    centers,
    halves,
    enabled,
    roadItems,
    roadCenters: Float32Array.from(roadCenters),
    roadHalves: Float32Array.from(roadHalves),
    roadBoxCount: roadCenters.length / 2,
    roadInstanceCount: instances,
  };
}

function samples(run: () => void, warmup: number, iterations: number): number[] {
  for (let i = 0; i < warmup; i++) run();
  const out: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    run();
    out.push(performance.now() - start);
  }
  return out;
}

async function main(): Promise<void> {
  await initFrameWasm();
  const rows: (string | number)[][] = [];
  const raw: Record<string, unknown> = {};
  for (const [count, iterations] of [
    [1_000, 400],
    [10_000, 200],
  ] as const) {
    const s = scene(count, count);
    const ts = new TsSolver();
    ts.rebindBase(s.priority, s.order);
    const tsBase = new Uint8Array(count);
    const tsRoad = new Uint8Array(s.roadInstanceCount);
    const frame = {
      viewportWidth: WIDTH,
      viewportHeight: HEIGHT,
      cellSizePx: CELL,
      baseCenters: s.centers,
      baseHalfSizes: s.halves,
      baseEnabled: s.enabled,
      roadItems: s.roadItems,
      roadCenters: s.roadCenters,
      roadHalfSizes: s.roadHalves,
      roadBoxCount: s.roadBoxCount,
    };
    const wasm = new WasmSolver();
    wasm.rebindBase(s.priority, s.order);
    const wasmBase = new Uint8Array(count);
    const wasmRoad = new Uint8Array(s.roadInstanceCount);
    const runTs = () => ts.solve(frame, tsBase, tsRoad);
    const runWasm = () => wasm.solve(frame, wasmBase, wasmRoad);
    // Both solve the same frame the same way.
    runTs();
    runWasm();
    const agree = tsBase.every((v, i) => v === wasmBase[i]) && tsRoad.every((v, i) => v === wasmRoad[i]);
    if (!agree) throw new Error(`the solvers disagree on ${s.name}`);
    const kept = tsBase.reduce((n, v) => n + v, 0);
    // Interleaved rounds, so neither path gets the warmer machine.
    const tsSamples: number[] = [];
    const wasmSamples: number[] = [];
    for (let round = 0; round < 4; round++) {
      tsSamples.push(...samples(runTs, 20, iterations / 4));
      wasmSamples.push(...samples(runWasm, 20, iterations / 4));
    }
    const tsStat = stat(tsSamples);
    const wasmStat = stat(wasmSamples);
    rows.push([s.name, kept, tsStat.median, tsStat.p95, wasmStat.median, wasmStat.p95]);
    raw[s.name] = { kept, ts: tsStat, wasm: wasmStat };
  }
  publish("B4 labels: collision solve per frame, ms", ["scene", "kept", "TS median", "TS p95", "Rust/Wasm median", "Rust/Wasm p95"], rows, raw);
  done();
}

main().catch(fail);
