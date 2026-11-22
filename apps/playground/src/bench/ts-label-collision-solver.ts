// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The label collision solve in TypeScript, the loser of B4 (labels), kept
// for bench-labels only: the engine solves in Rust/Wasm.

import { type LabelCollisionFrame, ROAD_ITEM_STRIDE } from "../../../../packages/immersive-map/src/labels/collisions/label-collision-solver.ts";

/** Whether road item `a` is placed before `b`: priority, secondary priority, sort priority, tile order, then the key's halves unsigned. */
function roadPrecedes(d: Int32Array, a: number, b: number): number {
  const x = a * ROAD_ITEM_STRIDE;
  const y = b * ROAD_ITEM_STRIDE;
  for (let field = 0; field < 4; field++) if (d[x + field] !== d[y + field]) return d[x + field]! - d[y + field]!;
  for (let field = 4; field < 6; field++) if (d[x + field] !== d[y + field]) return (d[x + field]! >>> 0) - (d[y + field]! >>> 0);
  return 0;
}

/**
 * The frame's label collision solve (the Swift `LabelCollisionSolver`):
 * every candidate, base labels and road instances together, in one strict
 * rank order, each accepted when none of its boxes overlaps a box already
 * placed by an earlier one. One pass, no budget, no seeding, no eviction:
 * the decision for a pose is a pure function of the pose, and the fades
 * smooth the changes between frames.
 *
 * The base labels' ranks and order are fixed at `rebindBase` (a topology
 * change), the order made by the working set. The road instances are few and
 * sorted per solve, merged with the base order by collision priority, a base
 * label first on a tie. The grid is a bucket per cell with intrusive lists
 * over flat typed arrays kept between frames, so a solve allocates nothing
 * once they have grown to the frame's size. A base label shares its space
 * with nobody (group 0). A road instance's glyphs share a group, so they
 * never block each other.
 *
 * The engine's solver runs in Rust/Wasm, which won the measurement
 * (docs/benchmarks/B04-labels.md): this TypeScript port is kept here for
 * the benchmark only.
 */
export class LabelCollisionSolver {
  private basePriority: Int32Array = new Int32Array(0);
  private baseOrder: Int32Array = new Int32Array(0);
  private roadOrder: number[] = [];

  private gridWidth = 0;
  private gridHeight = 0;
  private cellSizePx = 64;
  private cellHeads = new Int32Array(4096);
  private nodeNext = new Int32Array(4096);
  private nodeBox = new Int32Array(4096);
  private nodeCount = 0;
  /** Placed boxes: min x, min y, max x, max y. */
  private placed = new Float32Array(4096);
  private placedGroup = new Int32Array(1024);
  private placedCount = 0;
  /** The boxes of the item being tested, accepted only all together: min x, min y, max x, max y, and the cell span. */
  private pending = new Float32Array(256);
  private pendingCells = new Int32Array(256);
  private pendingCount = 0;

  get baseCount(): number {
    return this.basePriority.length;
  }

  /** The base labels' collision priorities, in the working set's index order, and their indices in rank order. */
  rebindBase(priority: Int32Array, order: Int32Array): void {
    this.basePriority = priority;
    this.baseOrder = order;
  }

  /**
   * Solves the frame, writing `baseVisible` (index-aligned with the base set)
   * and `roadVisible` (index-aligned with the road instance set, sized by
   * the caller: an instance not offered keeps the value it had) in place.
   */
  solve(frame: LabelCollisionFrame, baseVisible: Uint8Array, roadVisible: Uint8Array): void {
    this.resetGrid(frame.viewportWidth, frame.viewportHeight, frame.cellSizePx);
    const items = frame.roadItems;
    const data = items.data;
    const roadOrder = this.roadOrder;
    roadOrder.length = items.count;
    for (let i = 0; i < items.count; i++) roadOrder[i] = i;
    roadOrder.sort((a, b) => roadPrecedes(data, a, b));

    const basePriority = this.basePriority;
    const baseOrder = this.baseOrder;
    const baseTotal = baseOrder.length;
    // An index the frame's arrays do not reach is hidden, never read.
    const baseLimit = Math.min(basePriority.length, frame.baseCenters.length >> 1, frame.baseHalfSizes.length >> 1, frame.baseEnabled.length, baseVisible.length);
    const roadTotal = items.count;
    const centers = frame.baseCenters;
    const halves = frame.baseHalfSizes;
    const enabled = frame.baseEnabled;
    const roadCenters = frame.roadCenters;
    const roadHalves = frame.roadHalfSizes;
    let baseCursor = 0;
    let roadCursor = 0;
    while (baseCursor < baseTotal || roadCursor < roadTotal) {
      let takeBase: boolean;
      if (baseCursor < baseTotal && roadCursor < roadTotal) takeBase = basePriority[baseOrder[baseCursor]!]! <= data[roadOrder[roadCursor]! * ROAD_ITEM_STRIDE]!;
      else takeBase = baseCursor < baseTotal;
      if (takeBase) {
        const index = baseOrder[baseCursor++]!;
        if (index >= baseLimit) continue;
        if (enabled[index] === 0) {
          baseVisible[index] = 0;
          continue;
        }
        this.pendingCount = 0;
        const accepted = this.offer(centers[index * 2]!, centers[index * 2 + 1]!, halves[index * 2]!, halves[index * 2 + 1]!, 0) && this.pendingCount > 0;
        if (accepted) this.commitPending(0);
        baseVisible[index] = accepted ? 1 : 0;
      } else {
        const item = roadOrder[roadCursor++]!;
        const group = item + 1;
        this.pendingCount = 0;
        const start = data[item * ROAD_ITEM_STRIDE + 6]!;
        const end = data[item * ROAD_ITEM_STRIDE + 7]!;
        let accepted = end > start;
        for (let box = start; accepted && box < end; box++) {
          if (box >= frame.roadBoxCount) {
            accepted = false;
            break;
          }
          if (!this.offer(roadCenters[box * 2]!, roadCenters[box * 2 + 1]!, roadHalves[box * 2]!, roadHalves[box * 2 + 1]!, group)) accepted = false;
        }
        accepted = accepted && this.pendingCount > 0;
        if (accepted) this.commitPending(group);
        const target = data[item * ROAD_ITEM_STRIDE + 8]!;
        if (target >= 0 && target < roadVisible.length) roadVisible[target] = accepted ? 1 : 0;
      }
    }
  }

  private resetGrid(width: number, height: number, cellSizePx: number): void {
    this.cellSizePx = Math.max(1, cellSizePx);
    this.gridWidth = Math.max(1, Math.ceil(Math.max(1, width) / this.cellSizePx));
    this.gridHeight = Math.max(1, Math.ceil(Math.max(1, height) / this.cellSizePx));
    const cells = this.gridWidth * this.gridHeight;
    if (this.cellHeads.length < cells) this.cellHeads = new Int32Array(Math.max(cells, this.cellHeads.length * 2));
    this.cellHeads.fill(-1, 0, cells);
    this.nodeCount = 0;
    this.placedCount = 0;
  }

  /**
   * Tests one box against the placed ones and queues it for commit: false
   * when it overlaps a placed box of another group, or of any group for
   * group 0. A box entirely off screen is neither queued nor a collision.
   */
  private offer(cx: number, cy: number, hx: number, hy: number, group: number): boolean {
    const minX = cx - hx;
    const minY = cy - hy;
    const maxX = cx + hx;
    const maxY = cy + hy;
    const cell = this.cellSizePx;
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const viewportWidth = gridWidth * cell;
    const viewportHeight = gridHeight * cell;
    if (maxX < 0 || maxY < 0 || minX > viewportWidth || minY > viewportHeight) return true;
    const minCellX = Math.min(Math.max(Math.floor(Math.max(0, minX) / cell), 0), gridWidth - 1);
    const maxCellX = Math.min(Math.max(Math.floor(Math.min(viewportWidth, maxX) / cell), 0), gridWidth - 1);
    const minCellY = Math.min(Math.max(Math.floor(Math.max(0, minY) / cell), 0), gridHeight - 1);
    const maxCellY = Math.min(Math.max(Math.floor(Math.min(viewportHeight, maxY) / cell), 0), gridHeight - 1);
    const heads = this.cellHeads;
    const next = this.nodeNext;
    const boxes = this.nodeBox;
    const placed = this.placed;
    const groups = this.placedGroup;
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      const row = cellY * gridWidth;
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        let node = heads[row + cellX]!;
        while (node >= 0) {
          const box = boxes[node]!;
          const b = box * 4;
          if (minX < placed[b + 2]! && maxX > placed[b]! && minY < placed[b + 3]! && maxY > placed[b + 1]!) {
            if (group === 0 || groups[box] !== group) return false;
          }
          node = next[node]!;
        }
      }
    }
    // The item's own earlier boxes: a road label's glyphs are one group, so
    // they never block each other, matching the placed-box rule.
    const p = this.pendingCount++;
    if (this.pending.length < (p + 1) * 4) {
      const grown = new Float32Array(this.pending.length * 2);
      grown.set(this.pending);
      this.pending = grown;
      const cells = new Int32Array(this.pendingCells.length * 2);
      cells.set(this.pendingCells);
      this.pendingCells = cells;
    }
    this.pending[p * 4] = minX;
    this.pending[p * 4 + 1] = minY;
    this.pending[p * 4 + 2] = maxX;
    this.pending[p * 4 + 3] = maxY;
    this.pendingCells[p * 4] = minCellX;
    this.pendingCells[p * 4 + 1] = maxCellX;
    this.pendingCells[p * 4 + 2] = minCellY;
    this.pendingCells[p * 4 + 3] = maxCellY;
    return true;
  }

  private commitPending(group: number): void {
    const gridWidth = this.gridWidth;
    for (let p = 0; p < this.pendingCount; p++) {
      const box = this.placedCount++;
      if (this.placed.length < (box + 1) * 4) {
        const grown = new Float32Array(this.placed.length * 2);
        grown.set(this.placed);
        this.placed = grown;
      }
      if (this.placedGroup.length <= box) {
        const grown = new Int32Array(this.placedGroup.length * 2);
        grown.set(this.placedGroup);
        this.placedGroup = grown;
      }
      this.placed[box * 4] = this.pending[p * 4]!;
      this.placed[box * 4 + 1] = this.pending[p * 4 + 1]!;
      this.placed[box * 4 + 2] = this.pending[p * 4 + 2]!;
      this.placed[box * 4 + 3] = this.pending[p * 4 + 3]!;
      this.placedGroup[box] = group;
      const minCellX = this.pendingCells[p * 4]!;
      const maxCellX = this.pendingCells[p * 4 + 1]!;
      const minCellY = this.pendingCells[p * 4 + 2]!;
      const maxCellY = this.pendingCells[p * 4 + 3]!;
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const row = cellY * gridWidth;
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          const cell = row + cellX;
          const node = this.nodeCount++;
          if (this.nodeNext.length <= node) {
            const nextGrown = new Int32Array(this.nodeNext.length * 2);
            nextGrown.set(this.nodeNext);
            this.nodeNext = nextGrown;
            const boxGrown = new Int32Array(this.nodeBox.length * 2);
            boxGrown.set(this.nodeBox);
            this.nodeBox = boxGrown;
          }
          this.nodeNext[node] = this.cellHeads[cell]!;
          this.nodeBox[node] = box;
          this.cellHeads[cell] = node;
        }
      }
    }
  }
}
