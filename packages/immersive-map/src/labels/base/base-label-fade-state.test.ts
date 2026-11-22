// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelFadeStateTests`: the index-aligned fade
// state. A target takes effect from the next frame, alphas follow their
// tile's run across a topology change, and dropped labels leave no state
// behind.

import { describe, expect, test } from "vitest";
import { LabelWorkingSetChange, type LabelBlockMove } from "../common/label-working-set-change.ts";
import { BaseLabelFadeState } from "./base-label-fade-state.ts";

function set(count: number, moves: LabelBlockMove[] = []): LabelWorkingSetChange {
  return new LabelWorkingSetChange(count, moves);
}

function visible(...flags: boolean[]): Uint8Array {
  return Uint8Array.from(flags.map(Number));
}

function keys(...values: number[]): BigUint64Array {
  return BigUint64Array.from(values.map(BigInt));
}

function alphas(state: BaseLabelFadeState): number[] {
  return Array.from(state.currentAlphas);
}

describe("BaseLabelFadeState", () => {
  test("a hidden target starts the fade out on the following frame", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(1), 0);

    state.advance(visible(true), 0, 0, 1);
    expect(state.currentAlphas[0], "the first frame stores the target, the alpha moves from the next one").toBe(0);
    state.advance(visible(true), 0.1, 0, 1);
    expect(state.currentAlphas[0]).toBe(1);

    const stillVisible = state.advance(visible(false), 0.35, 0, 1);
    expect(state.currentAlphas[0], "the frame that flips the target still shows the label").toBe(1);
    expect(stillVisible, "and reports the fade it just started").toBe(true);

    const fadingOut = state.advance(visible(false), 0.6, 0, 1);
    expect(state.currentAlphas[0]).toBeCloseTo(0.75, 6);
    expect(fadingOut).toBe(true);

    const done = state.advance(visible(false), 2, 0, 1);
    expect(state.currentAlphas[0]).toBe(0);
    expect(done).toBe(false);
  });

  test("the fade in follows its own duration", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(1), 0);
    state.advance(visible(true), 0, 0.5, 1);
    state.advance(visible(true), 0.25, 0.5, 1);
    expect(state.currentAlphas[0]).toBeCloseTo(0.5, 6);
    state.advance(visible(true), 1, 0.5, 1);
    expect(state.currentAlphas[0]).toBe(1);
  });

  test("a missing target entry counts as hidden", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(2), 0);
    state.advance(visible(true, true), 0, 0, 0);
    state.advance(visible(true, true), 1, 0, 0);
    state.advance(visible(true), 2, 0, 0);
    state.advance(visible(true), 3, 0, 0);
    expect(alphas(state)).toEqual([1, 0]);
  });

  test("only the labels of the spans move", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(4), 0);
    state.advance(visible(true, true, true, true), 0, 0, 0, [1, 3], 1);
    state.advance(visible(true, true, true, true), 1, 0, 0, [1, 3], 1);
    expect(alphas(state)).toEqual([0, 1, 1, 0]);
  });

  // Three tiles of one label each. A pan drops the third, brings a new one
  // in second place and swaps the first two: the survivors' runs move, the
  // newcomer starts invisible.
  test("a rebind carries the surviving runs and drops the rest", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(3), 0);
    state.advance(visible(true, true, true), 0, 1, 1);
    state.advance(visible(true, true, true), 0.5, 1, 1);
    expect(alphas(state)).toEqual([0.5, 0.5, 0.5]);

    state.rebind(set(3, [{ oldStart: 1, newStart: 0, count: 1 }, { oldStart: 0, newStart: 2, count: 1 }]), 0.5);
    expect(state.count).toBe(3);
    expect(alphas(state), "alphas follow their runs, the newcomer starts invisible").toEqual([0.5, 0, 0.5]);

    state.advance(visible(true, true, true), 1, 1, 1);
    expect(alphas(state), "the carried labels keep their stored target and finish the fade").toEqual([1, 0, 1]);
  });

  // A tile of several labels moves as one block.
  test("a run moves whole", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(4), 0);
    state.advance(visible(false, true, true, false), 0, 0, 0);
    state.advance(visible(false, true, true, false), 1, 0, 0);
    expect(alphas(state)).toEqual([0, 1, 1, 0]);

    state.rebind(set(5, [{ oldStart: 1, newStart: 3, count: 2 }]), 1);
    expect(alphas(state)).toEqual([0, 0, 0, 1, 1]);
  });

  // A stale move past either end reads and writes only what fits.
  test("a move past the end is clipped", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(2), 0);
    state.advance(visible(true, true), 0, 0, 0);
    state.advance(visible(true, true), 1, 0, 0);

    state.rebind(set(2, [{ oldStart: 1, newStart: 1, count: 5 }]), 1);
    expect(alphas(state)).toEqual([0, 1]);
  });

  // The solve found the second label to be a copy of the first, from a
  // coarser tile: the shown copy's alpha goes to the winner and the copy
  // goes out at once, so the feature never draws twice.
  test("a transfer hands the fuller alpha to the winner and hides the loser", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(2), 0);
    state.advance(visible(false, true), 0, 0, 0);
    state.advance(visible(false, true), 1, 0, 0);
    expect(alphas(state)).toEqual([0, 1]);

    state.transfer(1, 0);
    expect(alphas(state)).toEqual([1, 0]);

    // The winner already fuller keeps its own alpha, the loser still goes.
    state.advance(visible(true, true), 1, 1, 1);
    state.advance(visible(true, true), 1.5, 1, 1);
    expect(alphas(state)).toEqual([1, 0.5]);
    state.transfer(1, 0);
    expect(alphas(state)).toEqual([1, 0]);
  });

  // A zoom step: the parent tile (keys 1, 2, 3) leaves and the exact tile
  // (keys 9, 2, 1) arrives in one change. No run survives, but the labels lit
  // in the tile that left keep their fade in the tile that arrived, matched
  // by key. The unlit one and the new one start over.
  test("a lit label keeps its fade when its tile is swapped", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(3), 0);
    state.advance(visible(true, true, false), 0, 0, 0);
    state.advance(visible(true, true, false), 1, 0, 0);
    expect(alphas(state)).toEqual([1, 1, 0]);

    const change = new LabelWorkingSetChange(3, [], [[0, 3]], [[0, 3]], keys(1, 2, 3), keys(9, 2, 1)).seeded(state.currentAlphas, 0.0001);
    expect(new Set(change.moves.map((move) => move.newStart))).toEqual(new Set([1, 2]));
    state.rebind(change, 1);
    expect(alphas(state)).toEqual([0, 1, 1]);

    // The carried target holds: the next frame moves nothing.
    state.advance(visible(true, true, true), 1.1, 1, 1);
    expect(state.currentAlphas[1]).toBe(1);
    expect(state.currentAlphas[2]).toBe(1);
  });

  // A copy that arrives beside a lit copy of its feature takes over at once,
  // wherever the lit copy is: here key 6 is lit in tile A, which stays, and
  // key 7 in two tiles that leave, where the fullest seeds.
  test("an arriving label is seeded from any lit copy", () => {
    // Old set: tile A [5, 6] stays, tile B [7] and tile C [7] leave.
    // New set: tile A [5, 6], tile D [6, 7] arrives.
    const old = Float32Array.from([1, 1, 0.25, 0.75]);
    const change = new LabelWorkingSetChange(4, [{ oldStart: 0, newStart: 0, count: 2 }], [[2, 3], [3, 4]], [[2, 4]], keys(5, 6, 7, 7), keys(5, 6, 6, 7)).seeded(old, 0.0001);
    expect(change.moves).toEqual([
      { oldStart: 0, newStart: 0, count: 2 },
      { oldStart: 1, newStart: 2, count: 1 },
      { oldStart: 3, newStart: 3, count: 1 },
    ]);
    expect(Array.from(change.carry(old, 0))).toEqual([1, 1, 1, 0.75]);
  });

  // The sequence that blinked: the exact tile arrived a frame ago and its
  // copy is still unlit (the buildings have not answered for it), and now
  // the parent leaves with the copy that was showing. The unlit copy in the
  // tile that stays takes the fade over. A label lit in the tile that stays
  // keeps its own, and an unlit one whose key nobody lit stays unlit.
  test("an unlit label of a surviving tile takes over a copy that left", () => {
    // Old set: child [7, 8, 9] at 0, parent [7, 9] at 3. The parent leaves.
    const old = Float32Array.from([0, 0, 0.5, 1, 1]);
    const change = new LabelWorkingSetChange(3, [{ oldStart: 0, newStart: 0, count: 3 }], [[3, 5]], [], keys(7, 8, 9, 7, 9), keys(7, 8, 9)).seeded(old, 0.0001);
    expect(change.moves).toEqual([
      { oldStart: 0, newStart: 0, count: 3 },
      { oldStart: 3, newStart: 0, count: 1 },
    ]);
    expect(Array.from(change.carry(old, 0))).toEqual([1, 0, 0.5]);
  });

  // A change that neither brings a tile nor loses a lit label has nothing to
  // seed and is handed back as it came.
  test("nothing to seed leaves the change alone", () => {
    const moves = [{ oldStart: 0, newStart: 0, count: 2 }];
    const quiet = new LabelWorkingSetChange(2, moves, [], [], keys(1, 2), keys(1, 2));
    expect(quiet.seeded(Float32Array.from([1, 0]), 0.0001)).toBe(quiet);
    const unlitDeparture = new LabelWorkingSetChange(2, moves, [[2, 3]], [], keys(1, 2, 2), keys(1, 2));
    expect(unlitDeparture.seeded(Float32Array.from([1, 0, 0]), 0.0001).moves, "the label that left was not lit").toEqual(moves);
  });

  test("a rebind with identity moves keeps everything", () => {
    const state = new BaseLabelFadeState();
    state.rebind(set(2), 0);
    state.advance(visible(true, false), 0, 0, 0);
    state.advance(visible(true, false), 1, 0, 0);
    state.rebind(set(2, [{ oldStart: 0, newStart: 0, count: 2 }]), 5);
    expect(alphas(state)).toEqual([1, 0]);
  });

  test("carry fills the slots no run reached with the initial value", () => {
    const carried = set(3, [{ oldStart: 0, newStart: 1, count: 1 }]).carry(Float64Array.from([4, 5]), 9);
    expect(Array.from(carried)).toEqual([9, 4, 9]);
    expect(carried).toBeInstanceOf(Float64Array);
  });
});
