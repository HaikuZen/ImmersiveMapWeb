// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `LabelCollisionSolverTests`: the per-frame collision
// solve, one strict rank order over base labels and road instances, the first
// placed keeps the space, a road instance is accepted only with all its glyph
// boxes, and the answer is the same whatever order the inputs came in.

import { describe, expect, test } from "vitest";
import { keyHalves, makeBaseLabelRanks, sortedRankOrder } from "./base-label-rank.ts";
import { LabelCollisionRoadItems, LabelCollisionSolver } from "./label-collision-solver.ts";

type Point = readonly [number, number];

interface Rank {
  readonly priority: number;
  readonly sort: number;
  readonly key: number;
}

function rank(priority: number, key: number, sort = 0): Rank {
  return { priority, sort, key };
}

interface RoadItem {
  readonly priority: number;
  readonly key: number;
  readonly boxStart: number;
  readonly boxEnd: number;
  readonly target: number;
}

/** Binds the base ranks in the order the working set would hand over. */
function rebind(solver: LabelCollisionSolver, list: readonly Rank[]): void {
  const ranks = makeBaseLabelRanks(list.length);
  list.forEach((entry, index) => {
    const [hi, lo] = keyHalves(BigInt(entry.key));
    ranks.priority[index] = entry.priority;
    ranks.sortPriority[index] = entry.sort;
    ranks.keyHi[index] = hi;
    ranks.keyLo[index] = lo;
  });
  solver.rebindBase(ranks.priority, sortedRankOrder(ranks, list.length));
}

function flat(points: readonly Point[]): Float32Array {
  return Float32Array.from(points.flat());
}

interface SolveInput {
  readonly centers: readonly Point[];
  readonly halfSizes?: readonly Point[];
  readonly enabled?: readonly boolean[];
  readonly roadItems?: readonly RoadItem[];
  readonly roadCenters?: readonly Point[];
  readonly roadHalfSizes?: readonly Point[];
  readonly road?: readonly boolean[];
}

function solve(solver: LabelCollisionSolver, input: SolveInput): { base: boolean[]; road: boolean[] } {
  const items = new LabelCollisionRoadItems();
  for (const item of input.roadItems ?? []) {
    const [hi, lo] = keyHalves(BigInt(item.key));
    items.push(item.priority, 0, 0, 0, hi, lo, item.boxStart, item.boxEnd, item.target);
  }
  const count = input.centers.length;
  const roadCenters = input.roadCenters ?? [];
  const base = new Uint8Array(count);
  const road = Uint8Array.from((input.road ?? []).map(Number));
  solver.solve(
    {
      viewportWidth: 1000,
      viewportHeight: 1000,
      cellSizePx: 32,
      baseCenters: flat(input.centers),
      baseHalfSizes: flat(input.halfSizes ?? input.centers.map((): Point => [20, 10])),
      baseEnabled: Uint8Array.from((input.enabled ?? input.centers.map(() => true)).map(Number)),
      roadItems: items,
      roadCenters: flat(roadCenters),
      roadHalfSizes: flat(input.roadHalfSizes ?? []),
      roadBoxCount: roadCenters.length,
    },
    base,
    road,
  );
  return { base: Array.from(base, Boolean), road: Array.from(road, Boolean) };
}

describe("LabelCollisionSolver", () => {
  test("the higher rank keeps the space whatever the index order", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(5, 1), rank(1, 2)]);
    expect(solve(solver, { centers: [[100, 100], [110, 105]] }).base, "index 1 has the better rank and is placed first").toEqual([false, true]);
  });

  test("an equal rank falls to the stable key", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(1, 20), rank(1, 10)]);
    expect(solve(solver, { centers: [[100, 100], [110, 105]] }).base).toEqual([false, true]);
  });

  test("the sort priority orders before the key", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(1, 1, 9), rank(2, 2), rank(1, 3, 3)]);
    expect(solve(solver, { centers: [[100, 100], [105, 100], [110, 100]] }).base).toEqual([false, false, true]);
  });

  test("non-overlapping labels all show", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(1, 1), rank(1, 2), rank(1, 3)]);
    expect(solve(solver, { centers: [[100, 100], [300, 100], [100, 300]] }).base).toEqual([true, true, true]);
  });

  test("touching boxes do not collide", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(1, 1), rank(1, 2)]);
    // Half width 20: centres 40 apart share an edge, and an edge is not an overlap.
    expect(solve(solver, { centers: [[100, 100], [140, 100]] }).base).toEqual([true, true]);
  });

  test("disabled and offscreen labels are hidden and take no space", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(0, 1), rank(0, 2), rank(5, 3)]);
    const result = solve(solver, { centers: [[100, 100], [-500, -500], [105, 100]], enabled: [false, true, true] });
    expect(result.base, "the disabled top-ranked label blocks nothing, the off-screen one is hidden without a fight").toEqual([false, false, true]);
  });

  test("a box straddling the viewport edge still counts", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(0, 1), rank(1, 2)]);
    expect(solve(solver, { centers: [[-5, 500], [10, 500]] }).base).toEqual([true, false]);
  });

  // Two labels at one point never both show, whatever their keys: the
  // working set has already left out the copies of one feature.
  test("labels of the same key block each other", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(0, 7), rank(0, 7)]);
    expect(solve(solver, { centers: [[100, 100], [100, 100]] }).base).toEqual([true, false]);
  });

  test("a road instance's own glyphs never block each other", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, []);
    const result = solve(solver, {
      centers: [],
      roadItems: [{ priority: 9, key: 100, boxStart: 0, boxEnd: 2, target: 0 }],
      roadCenters: [[200, 500], [205, 500]],
      roadHalfSizes: [[12, 8], [12, 8]],
      road: [false],
    });
    expect(result.road).toEqual([true]);
  });

  test("a road instance is accepted only with all its glyphs", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(0, 1)]);
    // Base label at (100, 100). Road instance A's glyphs run 200..260 (clear),
    // instance B's second glyph lands on the base label.
    const roadCenters: Point[] = [[200, 500], [230, 500], [260, 500], [400, 100], [110, 100]];
    const result = solve(solver, {
      centers: [[100, 100]],
      roadItems: [
        { priority: 9, key: 100, boxStart: 0, boxEnd: 3, target: 0 },
        { priority: 9, key: 101, boxStart: 3, boxEnd: 5, target: 1 },
      ],
      roadCenters,
      roadHalfSizes: roadCenters.map((): Point => [12, 8]),
      road: [false, false],
    });
    expect(result.base).toEqual([true]);
    expect(result.road).toEqual([true, false]);
  });

  // The Swift solver grouped glyphs by the instance key. The port groups them
  // per item, so two instances of one key still block each other.
  test("two road instances of one key block each other", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, []);
    const result = solve(solver, {
      centers: [],
      roadItems: [
        { priority: 9, key: 100, boxStart: 0, boxEnd: 1, target: 0 },
        { priority: 9, key: 100, boxStart: 1, boxEnd: 2, target: 1 },
      ],
      roadCenters: [[200, 500], [205, 500]],
      roadHalfSizes: [[12, 8], [12, 8]],
      road: [false, false],
    });
    expect(result.road).toEqual([true, false]);
  });

  test("road and base labels share one rank order", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(5, 1)]);
    const result = solve(solver, {
      centers: [[105, 100]],
      roadItems: [{ priority: 1, key: 100, boxStart: 0, boxEnd: 1, target: 0 }],
      roadCenters: [[100, 100]],
      roadHalfSizes: [[12, 8]],
      road: [false],
    });
    expect(result.base, "the road instance outranks the base label here").toEqual([false]);
    expect(result.road).toEqual([true]);
  });

  test("a base label wins a tie of collision priority against a road instance", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, [rank(3, 1)]);
    const result = solve(solver, {
      centers: [[105, 100]],
      roadItems: [{ priority: 3, key: 0, boxStart: 0, boxEnd: 1, target: 0 }],
      roadCenters: [[100, 100]],
      roadHalfSizes: [[12, 8]],
      road: [false],
    });
    expect(result.base).toEqual([true]);
    expect(result.road).toEqual([false]);
  });

  test("an instance not offered keeps the caller's value", () => {
    const solver = new LabelCollisionSolver();
    rebind(solver, []);
    const result = solve(solver, {
      centers: [],
      roadItems: [{ priority: 1, key: 5, boxStart: 0, boxEnd: 1, target: 0 }],
      roadCenters: [[100, 100]],
      roadHalfSizes: [[5, 5]],
      road: [false, true],
    });
    expect(result.road, "index 1 was not offered and stays as it was").toEqual([true, true]);
  });

  test("repeated solves are deterministic and reuse the grid", () => {
    const solver = new LabelCollisionSolver();
    let state = 12345;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state / 4294967296) * 1000;
    };
    const count = 400;
    const ranks: Rank[] = [];
    const centers: Point[] = [];
    for (let index = 0; index < count; index++) {
      ranks.push(rank(index % 5, index + 1));
      centers.push([random(), random()]);
    }
    rebind(solver, ranks);
    const first = solve(solver, { centers });
    const second = solve(solver, { centers });
    expect(first.base).toEqual(second.base);
    expect(first.base).toContain(true);
    expect(first.base, "four hundred boxes on a thousand-pixel square must collide somewhere").toContain(false);
    // Every shown pair is disjoint: the grid missed nothing.
    for (let a = 0; a < count; a++) {
      if (!first.base[a]) continue;
      for (let b = a + 1; b < count; b++) {
        if (!first.base[b]) continue;
        const dx = Math.abs(centers[a]![0] - centers[b]![0]);
        const dy = Math.abs(centers[a]![1] - centers[b]![1]);
        expect(dx < 40 && dy < 20, `${a} and ${b} overlap yet both show`).toBe(false);
      }
    }
  });
});
