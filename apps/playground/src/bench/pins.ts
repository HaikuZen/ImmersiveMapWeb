// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B4 (pins): the frame's pin collision layout in TypeScript (the port kept
// here, ts-pin-collision-layout-solver.ts) against the same solver in
// Rust/Wasm on the main thread (crates/frame-wasm/src/pins.rs) through the
// engine's adapter (PinCollisionLayoutSolver), the Wasm path paying what a
// frame pays: the pins gathered into one Float64Array and copied into Wasm
// memory, the result copied out and turned back into items and flowers.
//
// The scenes are a 2560 by 1600 drawable with 1 000 and 10 000 pins from a
// fixed seed: scattered pins, dense piles that become flowers, small groups
// of "event" pins, some selected or prioritised, some larger or smaller. The
// view pans slowly along a circle (a 120 frame loop at 60 fps), so the
// smoothing, the crossfades and the grouping hysteresis work as in a pan.
// The scenes of the Swift PinPerformanceTests (a 30 000 pin pile, a 2 000 pin
// spread, 10 000 pins in 200 houses) are measured standing still.

import { initFrameWasm } from "../../../../packages/immersive-map/src/frame/frame-wasm.ts";
import { defaultPinSettings } from "../../../../packages/immersive-map/src/configuration/pin-settings.ts";
import { ImmersiveMapPin, PinImageSource } from "../../../../packages/immersive-map/src/pins/immersive-map-pin.ts";
import type { PinCollisionGeometry, PinCollisionLayout, ProjectedPin } from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-types.ts";
import { PinCollisionLayoutSolver as WasmSolver } from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-layout-solver.ts";
import { PinCollisionLayoutSolver as TsSolver } from "./ts-pin-collision-layout-solver.ts";
import { done, fail, publish, stat } from "./harness.ts";

/** Doubles per pin into Wasm and per item out of it (pins.rs). */
const PIN_INPUT_STRIDE = 10;
const PIN_ITEM_STRIDE = 7;
const WIDTH = 2560;
const HEIGHT = 1600;
const LOOP = 120;
const PAN_RADIUS = 48;
/** Pixels per world unit: a linear map of the screen into the world. */
const WORLD_SCALE = 1 << 20;

/** The geometry of the Swift performance tests: a 128 px pin. */
const geometry: PinCollisionGeometry = { pinSizePx: 128, bodyRadiusPx: 64, circleBodyRadiusPx: 59, bodyCenterOffsetX: 0, bodyCenterOffsetY: 70 };
const config = { ...defaultPinSettings };

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

interface Scene {
  readonly name: string;
  readonly pins: ProjectedPin[];
  readonly baseX: Float64Array;
  readonly baseY: Float64Array;
  readonly moving: boolean;
}

const image = PinImageSource.remote("https://example.invalid/pin.png");

interface Spot {
  x: number;
  y: number;
  selected?: boolean;
  priority?: number;
  event?: boolean;
  sizeScale?: number;
}

function makeScene(name: string, spots: Spot[], moving: boolean): Scene {
  const pins: ProjectedPin[] = [];
  const baseX = new Float64Array(spots.length);
  const baseY = new Float64Array(spots.length);
  spots.forEach((spot, index) => {
    const pin = ImmersiveMapPin.make({
      id: index + 1,
      coordinate: { latitude: 0, longitude: 0 },
      image,
      isSelected: spot.selected ?? false,
      drawPriority: spot.priority ?? 0,
      clusterPolicy: spot.event ? "event" : "none",
      screenSizeScale: spot.sizeScale ?? 1,
    });
    baseX[index] = spot.x;
    baseY[index] = spot.y;
    pins.push({
      pin,
      squashScaleX: 1,
      squashScaleY: 1,
      screenPoint: { positionX: spot.x, positionY: spot.y, depth: 0.5, visible: 1, visibilityAlpha: 1 },
      worldX: spot.x / WORLD_SCALE,
      worldY: spot.y / WORLD_SCALE,
      drawOrder: index,
    });
  });
  return { name, pins, baseX, baseY, moving };
}

/** A realistic mix: scattered pins, dense piles, event groups, a few selected and prioritised. */
function mixedScene(count: number, seed: number): Scene {
  const next = random(seed);
  const spots: Spot[] = [];
  const decorate = (spot: Spot): Spot => {
    const roll = next();
    if (roll < 0.01) spot.selected = true;
    else if (roll < 0.11) spot.priority = 1 + Math.floor(next() * 3);
    if (next() < 0.1) spot.sizeScale = 0.8 + next() * 0.5;
    return spot;
  };
  const scattered = Math.round(count * 0.55);
  for (let i = 0; i < scattered; i++) spots.push(decorate({ x: next() * (WIDTH + 400) - 200, y: next() * (HEIGHT + 400) - 200 }));
  // Dense piles of 10 to 60 pins, 30 to 150 px across.
  let piled = Math.round(count * 0.35);
  while (piled > 0) {
    const size = Math.min(piled, 10 + Math.floor(next() * 50));
    const cx = next() * WIDTH;
    const cy = next() * HEIGHT;
    const radius = 15 + next() * 60;
    for (let i = 0; i < size; i++) {
      const angle = next() * Math.PI * 2;
      const distance = radius * Math.sqrt(next());
      spots.push(decorate({ x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance }));
    }
    piled -= size;
  }
  // Event groups of 2 to 6 within a pin of each other.
  while (spots.length < count) {
    const size = Math.min(count - spots.length, 2 + Math.floor(next() * 5));
    const cx = next() * WIDTH;
    const cy = next() * HEIGHT;
    for (let i = 0; i < size; i++) spots.push(decorate({ x: cx + (next() - 0.5) * 120, y: cy + (next() - 0.5) * 120, event: true }));
  }
  // Ids in a random spatial order, as an app hands its pins over.
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [spots[i], spots[j]] = [spots[j]!, spots[i]!];
  }
  return makeScene(`${count} pins, mixed, panning`, spots, true);
}

/** The Swift PinPerformanceTests scenes. */
function swiftScenes(): Scene[] {
  const pile = random(42);
  const pileSpots = Array.from({ length: 30_000 }, () => {
    const angle = pile() * Math.PI * 2;
    const distance = 150 * Math.sqrt(pile());
    return { x: 800 + Math.cos(angle) * distance, y: 500 + Math.sin(angle) * distance };
  });
  const spread = random(7);
  const columns = Math.floor(3840 / 78);
  const spreadSpots = Array.from({ length: 2_000 }, (_, i) => ({ x: (i % columns) * 78 + 39 + (spread() - 0.5) * 16, y: Math.floor(i / columns) * 78 + 39 + (spread() - 0.5) * 16 }));
  const houses = random(1234);
  const centers = Array.from({ length: 200 }, () => [houses() * 1920, houses() * 1080] as const);
  const houseSpots = Array.from({ length: 10_000 }, (_, i) => {
    const [cx, cy] = centers[i % 200]!;
    const angle = houses() * Math.PI * 2;
    const distance = 60 * houses();
    return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance };
  });
  return [makeScene("Swift pile, 30 000 pins, still", pileSpots, false), makeScene("Swift spread, 2 000 pins, still", spreadSpots, false), makeScene("Swift houses, 10 000 pins, still", houseSpots, false)];
}

/** Moves the scene's anchors to frame `frame` of the pan loop (untimed). */
function setFrame(scene: Scene, frame: number): void {
  if (!scene.moving) return;
  const angle = (2 * Math.PI * (frame % LOOP)) / LOOP;
  const dx = Math.cos(angle) * PAN_RADIUS;
  const dy = Math.sin(angle) * PAN_RADIUS;
  for (let i = 0; i < scene.pins.length; i++) {
    const point = scene.pins[i]!.screenPoint;
    point.positionX = scene.baseX[i]! + dx;
    point.positionY = scene.baseY[i]! + dy;
  }
}

interface Comparison {
  maxDifference: number;
}

/** Throws unless the two layouts make the same decisions, and returns the largest numeric difference. */
function compare(a: PinCollisionLayout, b: PinCollisionLayout, label: string): Comparison {
  if (a.pinItems.length !== b.pinItems.length || a.flowerGroups.length !== b.flowerGroups.length || a.hasActiveAnimations !== b.hasActiveAnimations) {
    throw new Error(`${label}: ${a.pinItems.length}/${b.pinItems.length} items, ${a.flowerGroups.length}/${b.flowerGroups.length} flowers, animating ${a.hasActiveAnimations}/${b.hasActiveAnimations}`);
  }
  let maxDifference = 0;
  const note = (x: number, y: number) => {
    maxDifference = Math.max(maxDifference, Math.abs(x - y));
  };
  a.pinItems.forEach((item, k) => {
    const other = b.pinItems[k]!;
    if (item.pin !== other.pin || item.isFlowerPetal !== other.isFlowerPetal) throw new Error(`${label}: item ${k} differs`);
    note(item.screenPoint.positionX, other.screenPoint.positionX);
    note(item.screenPoint.positionY, other.screenPoint.positionY);
    note(item.screenPoint.visibilityAlpha, other.screenPoint.visibilityAlpha);
    note(item.displayScale, other.displayScale);
    note(item.morph, other.morph);
  });
  a.flowerGroups.forEach((group, f) => {
    const other = b.flowerGroups[f]!;
    if (group.memberIDs.join() !== other.memberIDs.join() || group.visibleMemberIDs.join() !== other.visibleMemberIDs.join()) throw new Error(`${label}: flower ${f} differs`);
    note(group.centerX, other.centerX);
    note(group.centerY, other.centerY);
  });
  if (maxDifference > 1e-6) throw new Error(`${label}: values differ by ${maxDifference}`);
  return { maxDifference };
}

async function main(): Promise<void> {
  await initFrameWasm();
  const params = new URLSearchParams(location.search);
  const only = params.get("scene");
  const scenes = [mixedScene(1_000, 1), mixedScene(10_000, 10), ...swiftScenes()].filter((scene) => only === null || scene.name.includes(only));
  const rows: (string | number)[][] = [];
  const raw: Record<string, unknown> = {};
  for (const scene of scenes) {
    const big = scene.pins.length > 10_000;
    const iterations = big ? 60 : scene.pins.length > 2_000 ? 200 : 400;
    const ts = new TsSolver();
    const wasm = new WasmSolver();
    let tsFrame = 0;
    let wasmFrame = 0;
    let time = 0;
    // Both paths lay out the same frames the same way, from a cold start through a whole pan loop.
    let maxDifference = 0;
    let last: PinCollisionLayout | null = null;
    const checkFrames = scene.moving ? LOOP + 30 : 20;
    for (let f = 0; f < checkFrames; f++) {
      setFrame(scene, f);
      const a = ts.solve(scene.pins, geometry, config, time);
      const b = wasm.solve(scene.pins, geometry, config, time);
      maxDifference = Math.max(maxDifference, compare(a, b, `${scene.name}, frame ${f}`).maxDifference);
      last = a;
      time += 1 / 60;
    }
    tsFrame = wasmFrame = checkFrames;
    const tsTime = { value: time };
    const wasmTime = { value: time };
    const runTs = () => {
      setFrame(scene, tsFrame++);
      const start = performance.now();
      ts.solve(scene.pins, geometry, config, tsTime.value);
      const elapsed = performance.now() - start;
      tsTime.value += 1 / 60;
      return elapsed;
    };
    const runWasm = () => {
      setFrame(scene, wasmFrame++);
      const start = performance.now();
      wasm.solve(scene.pins, geometry, config, wasmTime.value);
      const elapsed = performance.now() - start;
      wasmTime.value += 1 / 60;
      return elapsed;
    };
    const tsSamples: number[] = [];
    const wasmSamples: number[] = [];
    const rounds = 4;
    // Interleaved rounds, so neither path gets the warmer machine.
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 20; i++) runTs();
      for (let i = 0; i < iterations / rounds; i++) tsSamples.push(runTs());
      for (let i = 0; i < 20; i++) runWasm();
      for (let i = 0; i < iterations / rounds; i++) wasmSamples.push(runWasm());
    }
    const tsStat = stat(tsSamples);
    const wasmStat = stat(wasmSamples);
    const items = last!.pinItems.length;
    const flowers = last!.flowerGroups.length;
    const flowerDoubles = last!.flowerGroups.reduce((sum, group) => sum + 4 + group.memberIDs.length + group.visibleMemberIDs.length, 0);
    // Two copies cross the boundary per frame: the pins in, the result out.
    const bytesIn = scene.pins.length * PIN_INPUT_STRIDE * 8;
    const bytesOut = (3 + items * PIN_ITEM_STRIDE + flowerDoubles) * 8;
    rows.push([scene.name, items, flowers, tsStat.median, tsStat.p95, wasmStat.median, wasmStat.p95, `2, ${Math.round(bytesIn / 1024)} + ${Math.round(bytesOut / 1024)} KB`]);
    raw[scene.name] = { items, flowers, maxDifference, ts: tsStat, wasm: wasmStat, copies: 2, bytesIn, bytesOut };
  }
  publish("B4 pins: collision layout per frame, ms", ["scene", "items", "flowers", "TS median", "TS p95", "Rust/Wasm median", "Rust/Wasm p95", "copies, in + out"], rows, raw);
  done();
}

main().catch(fail);
