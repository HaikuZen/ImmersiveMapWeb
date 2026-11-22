// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The rank a base label competes with in the collision solve, lower first:
 * its collision priority, then its sort priority, then its key (the Swift
 * `BaseLabelRank`). All three come from the label itself, fixed when its
 * tile is parsed, never from the tile set it is in, so a tile's labels are
 * ranked once (`TileTextLabels.rankOrder`) and a set's order is its tiles'
 * orders merged (`mergeRankRuns`).
 *
 * Kept as columns over the labels of a set, the 64-bit key as its two
 * 32-bit halves, so a comparison reads four typed arrays and builds nothing.
 * The two priorities are clamped to 32 bits, as Swift packs them.
 */
export interface BaseLabelRanks {
  readonly priority: Int32Array;
  readonly sortPriority: Int32Array;
  readonly keyHi: Uint32Array;
  readonly keyLo: Uint32Array;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** `value` clamped to 32 bits, as Swift's `Int32(clamping:)`. */
export function clampInt32(value: number): number {
  if (!(value === value)) return 0;
  return Math.min(INT32_MAX, Math.max(INT32_MIN, Math.trunc(value)));
}

/** Empty rank columns for `count` labels. */
export function makeBaseLabelRanks(count: number): BaseLabelRanks {
  return { priority: new Int32Array(count), sortPriority: new Int32Array(count), keyHi: new Uint32Array(count), keyLo: new Uint32Array(count) };
}

/** Whether label `a` of `ranks` is placed before label `b` (both indices into the columns). */
export function rankPrecedes(ranks: BaseLabelRanks, a: number, b: number): boolean {
  const pa = ranks.priority[a]!;
  const pb = ranks.priority[b]!;
  if (pa !== pb) return pa < pb;
  const sa = ranks.sortPriority[a]!;
  const sb = ranks.sortPriority[b]!;
  if (sa !== sb) return sa < sb;
  const ha = ranks.keyHi[a]!;
  const hb = ranks.keyHi[b]!;
  if (ha !== hb) return ha < hb;
  return ranks.keyLo[a]! < ranks.keyLo[b]!;
}

/** Whether two labels of `ranks` rank the same. */
export function rankEquals(ranks: BaseLabelRanks, a: number, b: number): boolean {
  return ranks.priority[a] === ranks.priority[b] && ranks.sortPriority[a] === ranks.sortPriority[b] && ranks.keyHi[a] === ranks.keyHi[b] && ranks.keyLo[a] === ranks.keyLo[b];
}

/** The indices `0..<count` of `ranks` in rank order, ties in index order (the Swift `BaseLabelRankOrder.sorted`). */
export function sortedRankOrder(ranks: BaseLabelRanks, count: number): Int32Array {
  const order = new Int32Array(count);
  for (let index = 0; index < count; index++) order[index] = index;
  order.sort((lhs, rhs) => (rankPrecedes(ranks, lhs, rhs) ? -1 : rankPrecedes(ranks, rhs, lhs) ? 1 : lhs - rhs));
  return order;
}

/**
 * Merges `order`, whose runs (`runs`, start and end pairs) are each in rank
 * order and lie end to end from its start (anything after the last is one
 * more run), into one rank order, in place (the Swift
 * `BaseLabelRankOrder.mergeRuns`): adjacent runs are merged pairwise until
 * one is left, about log2 of the run count passes. `ranks` is read by the
 * indices `order` holds. Ties keep the earlier run first.
 */
export function mergeRankRuns(order: Int32Array, runs: ArrayLike<number>, ranks: BaseLabelRanks): void {
  let bounds: number[] = [0];
  for (let r = 0; r + 1 < runs.length; r += 2) {
    if (runs[r + 1]! > runs[r]!) bounds.push(runs[r + 1]!);
  }
  if (bounds[bounds.length - 1]! < order.length) bounds.push(order.length);
  if (bounds.length <= 2) return;
  let source: Int32Array = order;
  let target: Int32Array = new Int32Array(order.length);
  let nextBounds: number[] = [];
  while (bounds.length > 2) {
    nextBounds = [0];
    for (let pair = 0; pair + 1 < bounds.length; pair += 2) {
      const start = bounds[pair]!;
      // A last run without a partner is copied as it is.
      const middle = bounds[pair + 1]!;
      const end = pair + 2 < bounds.length ? bounds[pair + 2]! : middle;
      let left = start;
      let right = middle;
      let out = start;
      while (left < middle && right < end) {
        if (rankPrecedes(ranks, source[right]!, source[left]!)) target[out++] = source[right++]!;
        else target[out++] = source[left++]!;
      }
      while (left < middle) target[out++] = source[left++]!;
      while (right < end) target[out++] = source[right++]!;
      nextBounds.push(end);
    }
    const swap = source;
    source = target;
    target = swap;
    bounds = nextBounds;
  }
  if (source !== order) order.set(source);
}

/** A u64 key written as a decimal string, as its two 32-bit halves and as a bigint. 0 for a string that is no u64. */
export function parseLabelKey(text: string): bigint {
  try {
    const value = BigInt(text);
    return value >= 0n && value <= 0xffff_ffff_ffff_ffffn ? value : 0n;
  } catch {
    return 0n;
  }
}

/** The high and low 32 bits of a u64 key. */
export function keyHalves(key: bigint): [number, number] {
  return [Number(key >> 32n), Number(key & 0xffff_ffffn)];
}
