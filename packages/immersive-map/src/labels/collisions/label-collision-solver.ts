// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The frame's label collision solve (the Swift `LabelCollisionSolver`):
 * every candidate, base labels and road instances together, in one strict
 * rank order, each accepted when none of its boxes overlaps a box already
 * placed by an earlier one. One pass, no budget, no seeding, no eviction: the
 * decision for a pose is a pure function of the pose, and the fades smooth
 * the changes between frames.
 *
 * The base labels' ranks and order are fixed at `rebindBase` (a topology
 * change), the order made by the working set. The road instances are few and
 * sorted per solve, merged with the base order by collision priority, a base
 * label first on a tie. A base label shares its space with nobody. A road
 * instance's glyphs share a group, so they never block each other, and the
 * instance is kept or dropped whole.
 *
 * The solve runs in Rust/Wasm on the main thread (crates/frame-wasm,
 * `collisions.rs`): it beat the same solver in TypeScript by about 1.8 times
 * with the copies across the boundary counted.
 */

import { assertFrameWasm } from "../../frame/frame-wasm.ts";
import { LabelCollisionSolver as WasmLabelCollisionSolver } from "../../wasm/frame_wasm/frame_wasm.js";

/** Ints per road item, the order `collisions.rs` reads them in. */
export const ROAD_ITEM_STRIDE = 9;

/**
 * The road label instances offered to one solve (the Swift
 * `LabelCollisionRoadItem` and `LabelCollisionRank`), one flat array reused
 * between frames, the layout that crosses into Wasm as it is: priority,
 * secondary priority, sort priority, the order of its tile among the road
 * tiles, the stable key's high and low halves, the range of its glyph boxes
 * in the solve's road box arrays, and its index in the road label set, where
 * its decision lands. Lower ranks first, field by field in that order.
 */
export class LabelCollisionRoadItems {
  count = 0;
  data = new Int32Array(64 * ROAD_ITEM_STRIDE);

  clear(): void {
    this.count = 0;
  }

  push(priority: number, secondaryPriority: number, sortPriority: number, tileOrder: number, keyHi: number, keyLo: number, boxStart: number, boxEnd: number, targetIndex: number): void {
    if ((this.count + 1) * ROAD_ITEM_STRIDE > this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    const o = this.count++ * ROAD_ITEM_STRIDE;
    d[o] = priority;
    d[o + 1] = secondaryPriority;
    d[o + 2] = sortPriority;
    d[o + 3] = tileOrder;
    d[o + 4] = keyHi | 0;
    d[o + 5] = keyLo | 0;
    d[o + 6] = boxStart;
    d[o + 7] = boxEnd;
    d[o + 8] = targetIndex;
  }

  /** The used part of the array. */
  get items(): Int32Array {
    return this.data.subarray(0, this.count * ROAD_ITEM_STRIDE);
  }
}

/** The inputs of one frame's solve. Boxes are centres and half sizes in device pixels, two floats per box. */
export interface LabelCollisionFrame {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly cellSizePx: number;
  /** Index-aligned with the base set. A disabled label takes no space and is hidden. */
  readonly baseCenters: Float32Array;
  readonly baseHalfSizes: Float32Array;
  readonly baseEnabled: Uint8Array;
  readonly roadItems: LabelCollisionRoadItems;
  readonly roadCenters: Float32Array;
  readonly roadHalfSizes: Float32Array;
  /** The number of road boxes in `roadCenters` and `roadHalfSizes`. */
  readonly roadBoxCount: number;
}

export class LabelCollisionSolver {
  private readonly wasm: WasmLabelCollisionSolver;
  private count = 0;

  constructor() {
    assertFrameWasm();
    this.wasm = new WasmLabelCollisionSolver();
  }

  get baseCount(): number {
    return this.count;
  }

  /** The base labels' collision priorities, in the working set's index order, and their indices in rank order. */
  rebindBase(priority: Int32Array, order: Int32Array): void {
    this.count = priority.length;
    this.wasm.rebindBase(priority, order);
  }

  /**
   * Solves the frame, writing `baseVisible` (index-aligned with the base set)
   * and `roadVisible` (index-aligned with the road instance set, sized by
   * the caller: an instance not offered keeps the value it had) in place.
   */
  solve(frame: LabelCollisionFrame, baseVisible: Uint8Array, roadVisible: Uint8Array): void {
    const boxes = frame.roadBoxCount * 2;
    this.wasm.solve(
      frame.viewportWidth,
      frame.viewportHeight,
      frame.cellSizePx,
      frame.baseCenters,
      frame.baseHalfSizes,
      frame.baseEnabled,
      frame.roadItems.items,
      frame.roadCenters.subarray(0, boxes),
      frame.roadHalfSizes.subarray(0, boxes),
      baseVisible,
      roadVisible,
    );
  }
}
