// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelRankTests`: a base label's rank, and a
// set's rank order made by merging its tiles' orders instead of sorting the
// set.

import { describe, expect, test } from "vitest";
import { clampInt32, keyHalves, makeBaseLabelRanks, mergeRankRuns, rankPrecedes, sortedRankOrder, type BaseLabelRanks } from "./base-label-rank.ts";

interface Rank {
  readonly priority: number;
  readonly sortPriority: number;
  readonly key: bigint;
}

/** Rank columns over `list`, the priorities clamped as a parsed tile clamps them. */
function columns(list: readonly Rank[]): BaseLabelRanks {
  const ranks = makeBaseLabelRanks(list.length);
  list.forEach((rank, index) => {
    const [hi, lo] = keyHalves(rank.key);
    ranks.priority[index] = clampInt32(rank.priority);
    ranks.sortPriority[index] = clampInt32(rank.sortPriority);
    ranks.keyHi[index] = hi;
    ranks.keyLo[index] = lo;
  });
  return ranks;
}

function precedes(lhs: Rank, rhs: Rank): boolean {
  return rankPrecedes(columns([lhs, rhs]), 0, 1);
}

function rank(priority: number, sortPriority: number, key: number | bigint): Rank {
  return { priority, sortPriority, key: BigInt(key) };
}

/** A small deterministic generator, so a failing case is reproducible. */
function seeded(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
}

describe("BaseLabelRank", () => {
  test("the clamped priorities keep their order across signs", () => {
    const values = [Number.MIN_SAFE_INTEGER, -70_000, -1, 0, 1, 20_000, 70_000, Number.MAX_SAFE_INTEGER];
    for (const lhs of values) {
      for (const rhs of values) {
        expect(precedes(rank(lhs, 0, 0), rank(rhs, 0, 0)), `${lhs} against ${rhs}`).toBe(clampInt32(lhs) < clampInt32(rhs));
      }
    }
  });

  test("the collision priority outranks the sort priority, which outranks the key", () => {
    expect(precedes(rank(1, 900, 9), rank(2, -5, 1))).toBe(true);
    expect(precedes(rank(1, -3, 9), rank(1, 4, 1))).toBe(true);
    expect(precedes(rank(1, 4, 1), rank(1, 4, 9))).toBe(true);
    expect(precedes(rank(1, 4, 1), rank(1, 4, 1))).toBe(false);
  });

  test("the key compares as an unsigned 64-bit number", () => {
    expect(precedes(rank(0, 0, 0xffff_ffffn), rank(0, 0, 0x1_0000_0000n)), "the high half decides first").toBe(true);
    expect(precedes(rank(0, 0, 0xffff_ffff_ffff_fffen), rank(0, 0, 0xffff_ffff_ffff_ffffn))).toBe(true);
    expect(precedes(rank(0, 0, 0x8000_0000_0000_0000n), rank(0, 0, 1n)), "no sign bit").toBe(false);
  });

  test("the rank gives back its collision priority", () => {
    for (const priority of [-70_000, -1, 0, 50_072, 2147483647]) {
      expect(columns([rank(priority, 7, 0)]).priority[0]).toBe(priority);
    }
    expect(columns([rank(Number.MAX_SAFE_INTEGER, 0, 0)]).priority[0]).toBe(2147483647);
  });

  // Runs of every length, an empty one and an odd count among them, merge
  // into the order a sort of the whole gives.
  test("merging the runs gives the sorted order", () => {
    const random = seeded(7);
    for (const runCount of [1, 2, 3, 5, 8, 13]) {
      const list: Rank[] = [];
      const order: number[] = [];
      const runs: number[] = [];
      for (let run = 0; run < runCount; run++) {
        const length = run === 1 ? 0 : random(1, 40);
        const start = list.length;
        for (let index = 0; index < length; index++) list.push(rank(random(0, 6), random(-3, 3), random(1, 20)));
        const tileOrder = sortedRankOrder(columns(list.slice(start)), length);
        for (const index of tileOrder) order.push(index + start);
        runs.push(start, list.length);
      }
      const ranks = columns(list);
      const merged = Int32Array.from(order);
      mergeRankRuns(merged, runs, ranks);
      expect(Array.from(merged), `${runCount} runs`).toEqual(Array.from(sortedRankOrder(ranks, list.length)));
    }
  });

  // Two labels of one rank keep the earlier run's first.
  test("a tie keeps the earlier run first", () => {
    const same = rank(3, 0, 7);
    const ranks = columns([rank(4, 0, 1), same, same]);
    const order = Int32Array.from([1, 0, 2]);
    mergeRankRuns(order, [0, 2, 2, 3], ranks);
    expect(Array.from(order)).toEqual([1, 2, 0]);
  });
});
