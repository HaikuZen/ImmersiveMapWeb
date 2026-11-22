// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B4 (planner): the frame's tile placements in TypeScript (the planner as it
// was first ported, kept in ts-planner.ts) against the engine's Rust/Wasm
// planner (crates/frame-wasm) through its adapter, which copies the inputs
// and outputs across the boundary as a frame pays it.

import { initFrameWasm } from "../../../../packages/immersive-map/src/frame/frame-wasm.ts";
import { buildPlacements as buildPlacementsWasm } from "../../../../packages/immersive-map/src/tile/placement/tile-placement-planner.ts";
// The TypeScript planner the measurement replaced, kept here for it.
import { buildPlacements } from "./ts-planner.ts";
import type { PlaceTile, ResidentTile, VisibleTile } from "../../../../packages/immersive-map/src/tile/placement/place-tile.ts";
import { type Tile, tileKey } from "../../../../packages/immersive-map/src/tile/tile.ts";
import { done, fail, publish, stat } from "./harness.ts";

interface Scenario {
  name: string;
  targets: VisibleTile[];
  resident: Map<string, ResidentTile>;
  previous: PlaceTile<ResidentTile>[];
}

/** Targets as the ring rules lay them: a fine square around the centre, coarser rings around it. */
function targetsAround(cx: number, cy: number, z: number, rings: number[]): VisibleTile[] {
  const out: VisibleTile[] = [];
  rings.forEach((radius, ring) => {
    const zoom = z - ring;
    const x0 = cx >> ring;
    const y0 = cy >> ring;
    for (let y = y0 - radius; y <= y0 + radius; y++) {
      for (let x = x0 - radius; x <= x0 + radius; x++) {
        if (ring > 0 && Math.abs(x - x0) <= (rings[ring - 1]! >> 1) && Math.abs(y - y0) <= (rings[ring - 1]! >> 1)) continue;
        out.push({ tile: { z: zoom, x, y }, worldWrap: 0 });
      }
    }
  });
  return out;
}

const resident = (tiles: Tile[]) => new Map(tiles.map((tile) => [tileKey(tile), { tile }]));

function scenarios(): Scenario[] {
  const cx = 19807 * 2;
  const cy = 10243 * 2;
  const steady = targetsAround(cx, cy, 16, [5, 4, 3]);
  const steadyResident = resident(steady.map((t) => t.tile));
  // Zooming in: the new targets one level finer, a third of them in, the rest
  // stood in for by last frame's tiles.
  const zoomIn = targetsAround(cx * 2, cy * 2, 17, [5, 4, 3]);
  const zoomInResident = resident([...steady.map((t) => t.tile), ...zoomIn.filter((_, i) => i % 3 === 0).map((t) => t.tile)]);
  const steadyPlaced = buildPlacements({ targets: steady, resident: steadyResident });
  // Zooming out: the targets a level coarser, none in, the descendants shown.
  const zoomOut = targetsAround(cx >> 1, cy >> 1, 15, [5, 4, 3]);
  // A big frame: a wide window at a tilt, with 600 resident tiles.
  const wide = targetsAround(cx, cy, 16, [9, 7, 6, 5]);
  const wideResident = resident([...wide.map((t) => t.tile), ...wide.slice(0, 200).map((t) => ({ z: t.tile.z + 1, x: t.tile.x * 2, y: t.tile.y * 2 }))]);
  return [
    { name: `steady, ${steady.length} targets all resident`, targets: steady, resident: steadyResident, previous: steadyPlaced },
    { name: `zoom in, ${zoomIn.length} targets, a third resident`, targets: zoomIn, resident: zoomInResident, previous: steadyPlaced },
    { name: `zoom out, ${zoomOut.length} targets, descendants resident`, targets: zoomOut, resident: steadyResident, previous: steadyPlaced },
    { name: `wide, ${wide.length} targets, ${wideResident.size} resident`, targets: wide, resident: wideResident, previous: buildPlacements({ targets: wide, resident: wideResident }) },
  ];
}

function flatten(s: Scenario): { targets: Int32Array; resident: Int32Array; previous: Int32Array } {
  const targets = new Int32Array(s.targets.length * 4);
  s.targets.forEach((t, i) => targets.set([t.tile.z, t.tile.x, t.tile.y, t.worldWrap], i * 4));
  const resident = new Int32Array(s.resident.size * 3);
  let i = 0;
  for (const r of s.resident.values()) resident.set([r.tile.z, r.tile.x, r.tile.y], 3 * i++);
  const previous = new Int32Array(s.previous.length * 7);
  s.previous.forEach((p, k) => previous.set([p.resident.tile.z, p.resident.tile.x, p.resident.tile.y, p.placeIn.tile.z, p.placeIn.tile.x, p.placeIn.tile.y, p.placeIn.worldWrap], k * 7));
  return { targets, resident, previous };
}

/** A tile's quadtree index: unique below zoom 26, exact in a double. */
const qkey = (z: number, x: number, y: number) => (4 ** z - 1) / 3 + y * 2 ** z + x;
const vkey = (z: number, x: number, y: number, wrap: number) => qkey(z, x, y) * 64 + (wrap + 32);

/**
 * The same algorithm in TypeScript over numeric keys and flat arrays, the
 * layout the Rust port uses: the fair counterpart of the Wasm call.
 */
function planNumeric(targets: Int32Array, resident: Int32Array, previous: Int32Array, backdropZoom: number): number[] {
  const residentSet = new Set<number>();
  const branches = new Set<number>();
  for (let i = 0; i < resident.length; i += 3) {
    let z = resident[i]!, x = resident[i + 1]!, y = resident[i + 2]!;
    residentSet.add(qkey(z, x, y));
    for (;;) {
      const k = qkey(z, x, y);
      if (branches.has(k)) break;
      branches.add(k);
      if (z === 0) break;
      z--; x >>= 1; y >>= 1;
    }
  }
  const useful = (z: number) => backdropZoom < 0 || z > backdropZoom;
  const out: number[] = [];
  const seen = new Set<string>();
  const append = (sz: number, sx: number, sy: number, iz: number, ix: number, iy: number, w: number) => {
    const k = `${qkey(sz, sx, sy)}:${vkey(iz, ix, iy, w)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(sz, sx, sy, iz, ix, iy, w);
  };
  const byGround = new Map<number, number>();
  const inside = new Map<number, number[]>();
  for (let i = 0; i < previous.length; i += 7) {
    const sz = previous[i]!;
    if (!residentSet.has(qkey(sz, previous[i + 1]!, previous[i + 2]!)) || !useful(sz)) continue;
    const iz = previous[i + 3]!, ix = previous[i + 4]!, iy = previous[i + 5]!, w = previous[i + 6]!;
    const g = vkey(iz, ix, iy, w);
    if (!byGround.has(g)) byGround.set(g, i);
    for (let z = iz - 1; z >= 0; z--) {
      const d = iz - z;
      const a = vkey(z, ix >> d, iy >> d, w);
      const list = inside.get(a);
      if (list) list.push(i);
      else inside.set(a, [i]);
    }
  }
  const descendants = (z: number, x: number, y: number, w: number, found: number[]): boolean => {
    if (residentSet.has(qkey(z, x, y))) {
      found.push(z, x, y, z, x, y, w);
      return true;
    }
    if (!branches.has(qkey(z, x, y))) return false;
    let complete = true;
    for (let c = 0; c < 4; c++) complete = descendants(z + 1, x * 2 + (c & 1), y * 2 + (c >> 1), w, found) && complete;
    return complete;
  };
  for (let t = 0; t < targets.length; t += 4) {
    const z = targets[t]!, x = targets[t + 1]!, y = targets[t + 2]!, w = targets[t + 3]!;
    if (residentSet.has(qkey(z, x, y))) {
      append(z, x, y, z, x, y, w);
      continue;
    }
    const shownInside = inside.get(vkey(z, x, y, w)) ?? [];
    let over: number | undefined;
    for (let gz = z; over === undefined && gz >= 0; gz--) over = byGround.get(vkey(gz, x >> (z - gz), y >> (z - gz), w));
    for (const i of shownInside) append(previous[i]!, previous[i + 1]!, previous[i + 2]!, previous[i + 3]!, previous[i + 4]!, previous[i + 5]!, previous[i + 6]!);
    if (over !== undefined) {
      append(previous[over]!, previous[over + 1]!, previous[over + 2]!, z, x, y, w);
      continue;
    }
    if (shownInside.length === 0) {
      const found: number[] = [];
      const complete = branches.has(qkey(z, x, y)) && descendants(z, x, y, w, found);
      for (let i = 0; i < found.length; i += 7) append(found[i]!, found[i + 1]!, found[i + 2]!, found[i + 3]!, found[i + 4]!, found[i + 5]!, found[i + 6]!);
      if (complete && found.length > 0) continue;
    }
    for (let az = z - 1; az >= 0; az--) {
      if (!useful(az)) break;
      const ax = x >> (z - az), ay = y >> (z - az);
      if (residentSet.has(qkey(az, ax, ay))) {
        append(az, ax, ay, z, x, y, w);
        break;
      }
    }
  }
  return out;
}

async function run() {
  await initFrameWasm();
  const runs = Number(new URLSearchParams(location.search).get("runs") ?? 400);
  const rows: (string | number)[][] = [];
  const raw: unknown[] = [];
  for (const s of scenarios()) {
    const ts: number[] = [];
    const wasm: number[] = [];
    let tsCount = 0;
    let wasmCount = 0;
    let numericCount = 0;
    const numeric: number[] = [];
    for (let r = 0; r < runs + 20; r++) {
      let t0 = performance.now();
      const placed = buildPlacements({ targets: s.targets, resident: s.resident, previous: s.previous });
      const tsTime = performance.now() - t0;
      tsCount = placed.length;
      t0 = performance.now();
      // The adapter the map calls: flat arrays across and placements back.
      const out = buildPlacementsWasm({ targets: s.targets, resident: s.resident, previous: s.previous });
      const wasmTime = performance.now() - t0;
      wasmCount = out.length;
      t0 = performance.now();
      const flatTs = flatten(s);
      const outTs = planNumeric(flatTs.targets, flatTs.resident, flatTs.previous, -1);
      const numericTime = performance.now() - t0;
      numericCount = outTs.length / 7;
      if (r >= 20) {
        ts.push(tsTime);
        wasm.push(wasmTime);
        numeric.push(numericTime);
      }
    }
    const a = stat(ts);
    const b = stat(wasm);
    rows.push([s.name, "TypeScript", a.median, a.p95, tsCount]);
    rows.push([s.name, "Rust/Wasm through the adapter", b.median, b.p95, wasmCount]);
    const c = stat(numeric);
    rows.push([s.name, "TypeScript, numeric keys and flat arrays", c.median, c.p95, numericCount]);
    raw.push({ scenario: s.name, ts: a, wasm: b, numeric: c, tsCount, wasmCount, numericCount });
  }
  publish("B4: placement planner, ms per frame", ["scenario", "variant", "median ms", "p95 ms", "placements"], rows, raw);
  done();
}

run().catch(fail);
