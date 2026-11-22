// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `PinScreenHashGridTests`, for the TypeScript grid the
// benchmark's solver uses (the engine's grid is tested in Rust, pins.rs).

import { describe, expect, test } from "vitest";
import { PinDisjointSet, PinIndexList, PinScreenHashGrid } from "./ts-pin-screen-hash-grid.ts";

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

describe("PinScreenHashGrid", () => {
  test("neighbor pairs match a brute-force scan, including the order", () => {
    const next = random(99);
    const count = 600;
    const positions = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = -500 + next() * 2000;
      positions[i * 2 + 1] = -400 + next() * 1300;
    }
    const radius = 130;
    const distance = (a: number, b: number) => Math.hypot(positions[a * 2]! - positions[b * 2]!, positions[a * 2 + 1]! - positions[b * 2 + 1]!);
    const grid = new PinScreenHashGrid(positions, count, radius);
    const brute: number[][] = [];
    for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) if (distance(a, b) <= radius) brute.push([a, b]);
    const viaGrid: number[][] = [];
    const neighbors = new PinIndexList();
    for (let a = 0; a < count; a++) {
      grid.collectNeighbors(a, a, neighbors);
      for (const b of neighbors.toArray()) if (distance(a, b) <= radius) viaGrid.push([a, b]);
    }
    expect(viaGrid).toEqual(brute);
  });

  test("negative coordinates and cell boundaries", () => {
    // Floor quantization must not merge cells -1 and 0.
    const grid = new PinScreenHashGrid([-0.5, -0.5, 0.5, 0.5, -100, 0, 100, 0, 0, 0], 5, 100);
    const neighbors = new PinIndexList();
    grid.collectNeighbors(0, -1, neighbors);
    expect(neighbors.toArray()).toEqual([0, 1, 2, 4]);
    expect(grid.cellPopulationAt(0.5, 0.5)).toBe(2);
    expect(grid.cellPopulationAt(-0.5, -0.5)).toBe(1);
    expect(grid.cellPopulationAt(9999, 9999)).toBe(0);
  });

  test("empty and single point", () => {
    const neighbors = new PinIndexList();
    neighbors.push(1);
    neighbors.push(2);
    new PinScreenHashGrid([], 0, 50).collectCandidates(0, 0, neighbors);
    expect(neighbors.length).toBe(0);

    const single = new PinScreenHashGrid([10, 10], 1, 50);
    single.collectNeighbors(0, 0, neighbors);
    expect(neighbors.length).toBe(0);
    single.collectNeighbors(0, -1, neighbors);
    expect(neighbors.toArray()).toEqual([0]);
    single.collectCandidates(12, 8, neighbors);
    expect(neighbors.toArray()).toEqual([0]);
  });

  test("a dense pile keeps all entries in one neighborhood", () => {
    const count = 10_000;
    const positions = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = (i % 100) * 0.1;
      positions[i * 2 + 1] = Math.floor(i / 100) * 0.1;
    }
    const grid = new PinScreenHashGrid(positions, count, 64);
    expect(grid.cellPopulationAt(5, 5)).toBe(count);
    const neighbors = new PinIndexList();
    grid.collectNeighbors(0, 9_000, neighbors);
    expect(neighbors.toArray()).toEqual(Array.from({ length: 999 }, (_, i) => 9_001 + i));
    expect(grid.cellPopulationOfPoint(42)).toBe(count);
  });

  test("a rebuilt grid forgets the previous points", () => {
    const grid = new PinScreenHashGrid([0, 0, 1, 1, 2, 2], 3, 10);
    grid.build([500, 500], 1, 10);
    expect(grid.cellCount).toBe(1);
    expect(grid.cellPopulationAt(0, 0)).toBe(0);
    expect(grid.cellPopulationAt(501, 501)).toBe(1);
  });
});

describe("PinDisjointSet", () => {
  test("an iterative find survives a deep chain", () => {
    const count = 50_000;
    const set = new PinDisjointSet(count);
    for (let index = count - 2; index >= 0; index--) set.union(index, index + 1);
    expect(set.find(count - 1)).toBe(0);
    expect(set.find(count / 2)).toBe(0);
    expect(set.find(0)).toBe(0);
  });

  test("the root is the minimum index", () => {
    const set = new PinDisjointSet(6);
    set.union(4, 5);
    set.union(2, 4);
    expect(set.find(5)).toBe(2);
    set.union(5, 1);
    expect(set.find(4)).toBe(1);
    expect(set.find(0)).toBe(0);
    expect(set.find(3)).toBe(3);
  });
});
