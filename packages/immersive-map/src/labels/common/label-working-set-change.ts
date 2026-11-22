// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A run of a working set that survived a topology change: the labels of one
 * tile, contiguous in tile order in the old set and in the new one (the
 * Swift `LabelBlockMove`). The per-label state of a surviving tile is
 * carried by copying the run, no key is looked at: inside a tile nothing
 * ever moves, its labels and their order are fixed when it is parsed.
 */
export interface LabelBlockMove {
  readonly oldStart: number;
  readonly newStart: number;
  readonly count: number;
}

/** A typed array the state of a working set is kept in. */
type StateArray = Float32Array | Float64Array | Uint8Array | Int32Array;

/** Start and end of a run, end exclusive. */
export type LabelRun = readonly [number, number];

/**
 * What a topology change did to a working set: the new size, the runs that
 * survived, and the runs that left and arrived with their keys, for the
 * state arrays index-aligned with the set (the Swift `LabelWorkingSetChange`).
 *
 * A feature whose copy changes tile (the exact tile replacing the parent at
 * a zoom step, a tile boundary crossing it in a pan) is in no surviving run
 * and would start over invisible. `seeded` adds a one-label move for each
 * label that takes over a lit copy of its key, so the feature keeps its fade
 * whatever order its tiles come and go in.
 */
export class LabelWorkingSetChange {
  static readonly empty = new LabelWorkingSetChange(0, []);

  constructor(
    readonly count: number,
    readonly moves: readonly LabelBlockMove[],
    /** The runs of the old set whose tiles left (or were replaced). */
    readonly departedRuns: readonly LabelRun[] = [],
    /** The runs of the new set whose tiles arrived (or were replaced). */
    readonly arrivedRuns: readonly LabelRun[] = [],
    /** Each label's key in the old set and in the new one. */
    readonly previousKeys: BigUint64Array = new BigUint64Array(0),
    readonly keys: BigUint64Array = new BigUint64Array(0),
  ) {}

  /**
   * `old` carried into a new array of `count` entries, `initial` everywhere
   * a run did not survive. A move outside either array is clipped: a stale
   * move never reads or writes past an end.
   */
  carry<T extends StateArray>(old: T, initial: number): T {
    const next = new (old.constructor as new (length: number) => T)(this.count);
    if (initial !== 0) next.fill(initial);
    if (old.length === 0) return next;
    for (const move of this.moves) {
      const count = Math.min(move.count, old.length - move.oldStart, next.length - move.newStart);
      if (count <= 0 || move.oldStart < 0 || move.newStart < 0) continue;
      next.set(old.subarray(move.oldStart, move.oldStart + count) as never, move.newStart);
    }
    return next;
  }

  /**
   * The change with a one-label move for every label that should take over
   * the fade of another copy of its feature, matched by key:
   *
   * - a label of an arriving run, from the fullest lit copy anywhere in the
   *   old set. A copy that arrives beside a lit one takes over at once, and
   *   the frame's collision solve decides which of the two shows.
   * - an unlit label of a surviving run, from the fullest lit copy in a
   *   departing run: the copy that was showing left, this one is next.
   *
   * Two small sorted tables of lit labels (`oldAlphas` above `threshold`) and
   * a binary search per candidate, once per topology change and only when a
   * tile arrived or a lit label left.
   */
  seeded(oldAlphas: Float32Array, threshold: number): LabelWorkingSetChange {
    if (this.arrivedRuns.length === 0 && this.departedRuns.length === 0) return this;
    interface Entry {
      key: bigint;
      oldIndex: number;
      alpha: number;
    }
    const keys = this.previousKeys;
    const limit = Math.min(keys.length, oldAlphas.length);
    const departedLit: Entry[] = [];
    let allLit: Entry[] = [];
    for (const [start, end] of this.departedRuns) {
      for (let index = Math.max(0, start); index < Math.min(end, limit); index++) {
        if (oldAlphas[index]! > threshold) departedLit.push({ key: keys[index]!, oldIndex: index, alpha: oldAlphas[index]! });
      }
    }
    if (this.arrivedRuns.length > 0) {
      allLit = [...departedLit];
      for (const move of this.moves) {
        for (let index = Math.max(0, move.oldStart); index < Math.min(move.oldStart + move.count, limit); index++) {
          if (oldAlphas[index]! > threshold) allLit.push({ key: keys[index]!, oldIndex: index, alpha: oldAlphas[index]! });
        }
      }
    }
    if (departedLit.length === 0 && allLit.length === 0) return this;
    const ordered = (lhs: Entry, rhs: Entry): number => (lhs.key !== rhs.key ? (lhs.key < rhs.key ? -1 : 1) : rhs.alpha - lhs.alpha);
    departedLit.sort(ordered);
    allLit.sort(ordered);

    /** The first entry of `key` in a sorted table: its fullest copy. */
    const find = (key: bigint, table: readonly Entry[]): number => {
      let low = 0;
      let high = table.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (table[middle]!.key < key) low = middle + 1;
        else high = middle;
      }
      return low < table.length && table[low]!.key === key ? table[low]!.oldIndex : -1;
    };

    const newKeys = this.keys;
    const seeds: LabelBlockMove[] = [];
    if (allLit.length > 0) {
      for (const [start, end] of this.arrivedRuns) {
        for (let index = Math.max(0, start); index < Math.min(end, newKeys.length); index++) {
          const source = find(newKeys[index]!, allLit);
          if (source >= 0) seeds.push({ oldStart: source, newStart: index, count: 1 });
        }
      }
    }
    if (departedLit.length > 0) {
      for (const move of this.moves) {
        const count = Math.min(move.count, oldAlphas.length - move.oldStart, newKeys.length - move.newStart);
        for (let offset = 0; offset < count; offset++) {
          if (oldAlphas[move.oldStart + offset]! <= threshold) {
            const source = find(newKeys[move.newStart + offset]!, departedLit);
            if (source >= 0) seeds.push({ oldStart: source, newStart: move.newStart + offset, count: 1 });
          }
        }
      }
    }
    if (seeds.length === 0) return this;
    // After the block moves: a seed overwrites what its run carried.
    return new LabelWorkingSetChange(this.count, [...this.moves, ...seeds], this.departedRuns, this.arrivedRuns, this.previousKeys, this.keys);
  }
}
