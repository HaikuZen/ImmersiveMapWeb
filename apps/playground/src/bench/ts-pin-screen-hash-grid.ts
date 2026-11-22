// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The TypeScript broad phase of the pin solver kept for bench-pins
// (ts-pin-collision-layout-solver.ts). The engine's grid is in Rust
// (crates/frame-wasm, pins.rs).

/**
 * A uniform hash grid over screen positions (the Swift `PinScreenHashGrid`):
 * the broad phase of the collision and grouping solver. Any pair of points
 * within cellSize lands in adjacent (3 by 3) cells, so with cellSize at
 * least the maximum interaction distance the neighbor sweep is complete.
 *
 * The layout is compact (a counting sort): indices ascend within a cell, and
 * traversal is deterministic. Cell slots are numbered in the order their
 * first point appears. The neighbor cells of every slot are precomputed, so
 * queries by grid point never hash coordinates.
 *
 * The grid keeps its arrays between builds (`build` reuses them), so a
 * solve that rebuilds it every frame allocates nothing once they have grown.
 * Cell coordinates are clamped to plus or minus 2^20 (Swift traps past the
 * Int32 range), which keeps the hash keys exact.
 */

const CELL_LIMIT = 1 << 20;
const EMPTY = -1;

/** Pair lists by point (`starts`, `neighbors`), reused between builds. */
export class PinPairLists {
  starts = new Int32Array(64);
  neighbors = new Int32Array(256);
  scratch = new Int32Array(512);
  cursors = new Int32Array(64);
}

/** Growable list of indices, reused between queries. */
export class PinIndexList {
  data = new Int32Array(64);
  length = 0;

  clear(): void {
    this.length = 0;
  }

  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }

  /** Sorts the list ascending. */
  sort(): void {
    const d = this.data;
    const n = this.length;
    if (n > 24) {
      d.subarray(0, n).sort();
      return;
    }
    for (let i = 1; i < n; i++) {
      const value = d[i]!;
      let j = i - 1;
      while (j >= 0 && d[j]! > value) {
        d[j + 1] = d[j]!;
        j--;
      }
      d[j + 1] = value;
    }
  }

  toArray(): number[] {
    return Array.from(this.data.subarray(0, this.length));
  }
}

export function cellCoordinate(value: number, inverseCellSize: number): number {
  const cell = Math.floor(value * inverseCellSize);
  // NaN lands in cell 0, as a saturating float to int conversion does.
  if (!(cell === cell)) return 0;
  return cell < -CELL_LIMIT ? -CELL_LIMIT : cell > CELL_LIMIT ? CELL_LIMIT : cell;
}

export function grow(array: Int32Array<ArrayBuffer>, size: number): Int32Array<ArrayBuffer> {
  if (array.length >= size) return array;
  let length = Math.max(64, array.length);
  while (length < size) length *= 2;
  return new Int32Array(length);
}

export class PinScreenHashGrid {
  cellSize = 1;
  private inverseCellSize = 1;
  /** Open addressing table from cell coordinates to slots. */
  private tableX = new Int32Array(256);
  private tableY = new Int32Array(256);
  private tableSlot = new Int32Array(256).fill(EMPTY);
  private tableMask = 255;
  /** Cell coordinates of each slot. */
  private slotX = new Int32Array(64);
  private slotY = new Int32Array(64);
  /** Cell offsets into entries: slot s occupies starts[s] to starts[s + 1]. */
  starts = new Int32Array(64);
  /** Point indices grouped by cell, ascending within each cell. */
  entries = new Int32Array(64);
  /** Cell slot of each point. */
  slotForPoint = new Int32Array(64);
  /** Up to 9 slots of non-empty neighbor cells (including the cell itself) per slot, -1 for an empty one. */
  neighborSlots = new Int32Array(64 * 9);
  private cursors = new Int32Array(64);
  private slots = 0;
  private points = 0;

  /** A grid over `count` points whose coordinates are interleaved x, y in `positions`. */
  constructor(positions?: ArrayLike<number>, count?: number, cellSize?: number) {
    if (positions !== undefined) this.build(positions, count ?? positions.length / 2, cellSize ?? 1);
  }

  /** Number of grid cells. */
  get cellCount(): number {
    return this.slots;
  }

  build(positions: ArrayLike<number>, count: number, cellSize: number): this {
    const safeCellSize = Math.max(cellSize, 1);
    this.cellSize = safeCellSize;
    const inverse = 1 / safeCellSize;
    this.inverseCellSize = inverse;
    this.points = count;

    let tableSize = 256;
    while (tableSize < count * 2) tableSize *= 2;
    if (this.tableSlot.length < tableSize) {
      this.tableX = new Int32Array(tableSize);
      this.tableY = new Int32Array(tableSize);
      this.tableSlot = new Int32Array(tableSize);
    }
    this.tableSlot.fill(EMPTY, 0, tableSize);
    this.tableMask = tableSize - 1;

    this.slotForPoint = grow(this.slotForPoint, count);
    this.entries = grow(this.entries, count);
    this.slotX = grow(this.slotX, count);
    this.slotY = grow(this.slotY, count);
    this.starts = grow(this.starts, count + 1);
    this.cursors = grow(this.cursors, count + 1);
    const slotForPoint = this.slotForPoint;
    const counts = this.cursors;

    let slots = 0;
    for (let index = 0; index < count; index++) {
      const x = cellCoordinate(positions[index * 2]!, inverse);
      const y = cellCoordinate(positions[index * 2 + 1]!, inverse);
      let slot = this.find(x, y);
      if (slot === EMPTY) {
        slot = slots++;
        this.insert(x, y, slot);
        this.slotX[slot] = x;
        this.slotY[slot] = y;
        counts[slot] = 0;
      }
      slotForPoint[index] = slot;
      counts[slot]!++;
    }
    this.slots = slots;

    const starts = this.starts;
    starts[0] = 0;
    for (let slot = 0; slot < slots; slot++) {
      starts[slot + 1] = starts[slot]! + counts[slot]!;
      counts[slot] = starts[slot]!;
    }
    const entries = this.entries;
    for (let index = 0; index < count; index++) {
      const slot = slotForPoint[index]!;
      entries[counts[slot]!++] = index;
    }

    this.neighborSlots = grow(this.neighborSlots, slots * 9);
    const neighbors = this.neighborSlots;
    for (let slot = 0; slot < slots; slot++) {
      const cx = this.slotX[slot]!;
      const cy = this.slotY[slot]!;
      let offset = slot * 9;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          neighbors[offset++] = this.find(cx + dx, cy + dy);
        }
      }
    }
    return this;
  }

  private hash(x: number, y: number): number {
    return (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) & this.tableMask;
  }

  private find(x: number, y: number): number {
    const mask = this.tableMask;
    let at = this.hash(x, y);
    for (;;) {
      const slot = this.tableSlot[at]!;
      if (slot === EMPTY) return EMPTY;
      if (this.tableX[at] === x && this.tableY[at] === y) return slot;
      at = (at + 1) & mask;
    }
  }

  private insert(x: number, y: number, slot: number): void {
    const mask = this.tableMask;
    let at = this.hash(x, y);
    while (this.tableSlot[at] !== EMPTY) at = (at + 1) & mask;
    this.tableX[at] = x;
    this.tableY[at] = y;
    this.tableSlot[at] = slot;
  }

  /** Slot of the cell containing the grid point with the given index. */
  cellSlot(ofPoint: number): number {
    return this.slotForPoint[ofPoint]!;
  }

  /** Point indices of the cell at the given slot. */
  entriesInCellSlot(slot: number): number[] {
    return Array.from(this.entries.subarray(this.starts[slot]!, this.starts[slot + 1]!));
  }

  /** Slots of all cells whose population is at least the threshold, ascending. */
  cellSlotsWithPopulationAtLeast(threshold: number): number[] {
    const result: number[] = [];
    for (let slot = 0; slot < this.slots; slot++) {
      if (this.starts[slot + 1]! - this.starts[slot]! >= threshold) result.push(slot);
    }
    return result;
  }

  /** Number of points in the cell containing the grid point with the given index. */
  cellPopulationOfPoint(index: number): number {
    const slot = this.slotForPoint[index]!;
    return this.starts[slot + 1]! - this.starts[slot]!;
  }

  /** Number of points in the cell containing an arbitrary position (0 if empty). */
  cellPopulationAt(x: number, y: number): number {
    const slot = this.find(cellCoordinate(x, this.inverseCellSize), cellCoordinate(y, this.inverseCellSize));
    return slot === EMPTY ? 0 : this.starts[slot + 1]! - this.starts[slot]!;
  }

  /**
   * Collects neighbors of a grid point from the 3 by 3 neighborhood whose
   * index is strictly greater than `minIndex`, in ascending order. The fixed
   * order makes the (i, j > i) pair traversal reproducible.
   */
  collectNeighbors(index: number, minIndex: number, out: PinIndexList): void {
    out.clear();
    const base = this.slotForPoint[index]! * 9;
    const neighbors = this.neighborSlots;
    const starts = this.starts;
    const entries = this.entries;
    for (let offset = 0; offset < 9; offset++) {
      const slot = neighbors[base + offset]!;
      if (slot < 0) continue;
      const end = starts[slot + 1]!;
      for (let e = starts[slot]!; e < end; e++) {
        const point = entries[e]!;
        if (point > minIndex) out.push(point);
      }
    }
    out.sort();
  }

  /**
   * Every pair (i, j > i) of the grid's points in adjacent cells whose
   * distance is below the sum of their radii plus `margin`, as lists of j
   * per i, in (i, j) order: the order of the (i, j > i) traversal by
   * `collectNeighbors` without a sort per point. The pairs are found by
   * ascending j (a prefix of each ascending cell) and placed by a stable
   * counting sort on i. `positions` are the grid's own, interleaved.
   */
  ascendingPairs(positions: ArrayLike<number>, radii: ArrayLike<number>, margin: number, out: PinPairLists): void {
    const count = this.points;
    const starts = (out.starts = grow(out.starts, count + 1));
    starts.fill(0, 0, count + 1);
    let found = 0;
    let scratch = out.scratch;
    const neighbors = this.neighborSlots;
    const cellStarts = this.starts;
    const entries = this.entries;
    const slotForPoint = this.slotForPoint;
    for (let j = 0; j < count; j++) {
      const base = slotForPoint[j]! * 9;
      const jx = positions[j * 2]!;
      const jy = positions[j * 2 + 1]!;
      const jr = radii[j]!;
      for (let offset = 0; offset < 9; offset++) {
        const slot = neighbors[base + offset]!;
        if (slot < 0) continue;
        const end = cellStarts[slot + 1]!;
        for (let e = cellStarts[slot]!; e < end; e++) {
          const i = entries[e]!;
          if (i >= j) break;
          const reach = radii[i]! + jr + margin;
          const dx = positions[i * 2]! - jx;
          const dy = positions[i * 2 + 1]! - jy;
          if (!(dx * dx + dy * dy < reach * reach)) continue;
          if (found * 2 + 2 > scratch.length) {
            const grown = new Int32Array(Math.max(256, scratch.length * 2));
            grown.set(scratch);
            scratch = grown;
          }
          scratch[found * 2] = i;
          scratch[found * 2 + 1] = j;
          found++;
          starts[i + 1]!++;
        }
      }
    }
    out.scratch = scratch;
    for (let i = 0; i < count; i++) starts[i + 1] = starts[i + 1]! + starts[i]!;
    const list = (out.neighbors = grow(out.neighbors, found));
    const cursors = (out.cursors = grow(out.cursors, count));
    cursors.set(starts.subarray(0, count));
    for (let p = 0; p < found; p++) list[cursors[scratch[p * 2]!]!++] = scratch[p * 2 + 1]!;
  }

  /** All points in the 3 by 3 neighborhood of a grid point, itself included, in cell order: for folds that do not depend on the order. */
  collectCellNeighbors(index: number, out: PinIndexList): void {
    out.clear();
    const base = this.slotForPoint[index]! * 9;
    for (let offset = 0; offset < 9; offset++) {
      const slot = this.neighborSlots[base + offset]!;
      if (slot < 0) continue;
      const end = this.starts[slot + 1]!;
      for (let e = this.starts[slot]!; e < end; e++) out.push(this.entries[e]!);
    }
  }

  /**
   * Collects candidates around an arbitrary position (the 3 by 3
   * neighborhood), for points that are not part of the grid. The order is a
   * fixed cell traversal, not sorted by index: callers fold the candidates
   * commutatively.
   */
  collectCandidates(x: number, y: number, out: PinIndexList): void {
    out.clear();
    if (this.points === 0) return;
    const cx = cellCoordinate(x, this.inverseCellSize);
    const cy = cellCoordinate(y, this.inverseCellSize);
    const starts = this.starts;
    const entries = this.entries;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const slot = this.find(cx + dx, cy + dy);
        if (slot === EMPTY) continue;
        const end = starts[slot + 1]!;
        for (let e = starts[slot]!; e < end; e++) out.push(entries[e]!);
      }
    }
  }
}

/**
 * A disjoint-set structure with an iterative find (a recursive one
 * overflows the stack on long chains) and path compression. A component's
 * root is its minimum index, so membership is deterministic and ordered by
 * the smallest member. `reset` reuses the array.
 */
export class PinDisjointSet {
  private parent = new Int32Array(64);

  constructor(count = 0) {
    this.reset(count);
  }

  reset(count: number): void {
    this.parent = grow(this.parent, count);
    const parent = this.parent;
    for (let i = 0; i < count; i++) parent[i] = i;
  }

  find(index: number): number {
    const parent = this.parent;
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let current = index;
    while (parent[current] !== root) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  }

  union(lhs: number, rhs: number): void {
    const lhsRoot = this.find(lhs);
    const rhsRoot = this.find(rhs);
    if (lhsRoot === rhsRoot) return;
    if (lhsRoot < rhsRoot) this.parent[rhsRoot] = lhsRoot;
    else this.parent[lhsRoot] = rhsRoot;
  }
}
