// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The `labels` folder: the runtime label state after the schema-specific
 * decisions were made in the worker (language, fallback, identity, layout):
 * the base and road label caches, the collision inputs, the fades, the draw
 * batches and the surface label selection. It never knows the raw tile
 * schema.
 *
 * The base labels of the frame's tiles as one packed working set (the Swift
 * `BaseLabelCache`): the tiles in winner order (`BaseLabelSourceEntry`), each
 * tile's labels one run in tile order, the runs end to end. A label's index
 * in the set is its tile's start plus its index in the tile, the number the
 * tile's vertices carry plus the start the draw adds.
 *
 * The same feature reaches the set from several tiles (an exact tile and the
 * coarser one standing in beside it), each copy under the feature's key. The
 * set keeps one, the copy of the tile earliest in winner order, per world
 * wrap, and marks the others as its copies (`labelCopyOf`), which take no
 * part in the frame.
 *
 * Everything here is rebuilt when the tile set changes and read otherwise.
 * The rank order is the tiles' own orders merged, never a sort of the whole
 * set. Repacking hands back the change (`LabelWorkingSetChange`): which runs
 * survived and where they went, so the frame's per-label state is carried by
 * copying runs.
 */

import type { VisibleTile } from "../../tile/placement/place-tile.ts";
import type { Tile } from "../../tile/tile.ts";
import type { GpuTile } from "../../tile/store/tile-gpu.ts";
import { type BaseLabelRanks, makeBaseLabelRanks, mergeRankRuns } from "../collisions/base-label-rank.ts";
import { LabelWorkingSetChange, type LabelBlockMove, type LabelRun } from "../common/label-working-set-change.ts";
import type { BaseLabelSourceEntry } from "./base-label-source-entry.ts";
import { ownerKeyString } from "./base-label-source-entry.ts";
import type { BaseLabelPresentation } from "./base-label-visibility-resolver.ts";
import type { TileTextLabels } from "./tile-text-labels.ts";

/** What the label caches read of a resident tile. */
export interface LabelSourceTile {
  readonly tile: Tile;
  readonly gpu: GpuTile;
  readonly textLabels: TileTextLabels;
}

/**
 * The record the label shaders read per label, written every frame: the
 * anchor on screen in device pixels (origin bottom left), whether it is
 * drawable, the shrink for its distance, the fade, the collision box in
 * points. Eight floats, 32 bytes (`LabelFrameRecord` in label-text.wgsl).
 */
export const LabelFrameRecordLayout = {
  floats: 8,
  bytes: 32,
  screenX: 0,
  screenY: 1,
  visible: 2,
  perspectiveScale: 3,
  fadeAlpha: 4,
  sizeX: 5,
  sizeY: 6,
} as const;

/** One tile's base labels to draw: its arena's runs and where its labels start in the set. */
export interface BaseLabelDrawBatch {
  readonly gpu: GpuTile;
  readonly globalLabelStart: number;
  readonly labelCount: number;
}

/** One tile's run of the set. */
export interface BaseLabelTileRecord {
  readonly ownerKey: VisibleTile;
  readonly resident: LabelSourceTile;
  readonly start: number;
  readonly count: number;
}

export class BaseLabelCache {
  private records: BaseLabelTileRecord[] = [];

  /** The number of labels in the set, the length of every per-label column. */
  labelCount = 0;
  /** Each label's tile as z, x, y. */
  tiles = new Int32Array(0);
  /** Each label's tile record (its place in `records`, the frame's tile slot). */
  tileSlots = new Int32Array(0);
  uv = new Float32Array(0);
  roofHeight = new Float32Array(0);
  liftsToRoof = new Uint8Array(0);
  /** Each label's collision box half size in layout points, two per label. */
  halfSizes = new Float32Array(0);
  ranks: BaseLabelRanks = makeBaseLabelRanks(0);
  /** The set's labels in rank order, the order the collision solve places them in. Ties keep the earlier tile first. */
  rankOrder = new Int32Array(0);
  /** Each label's key, the identity a feature keeps across tiles. */
  keys = new BigUint64Array(0);
  presentation: BaseLabelPresentation = emptyPresentation(0);
  /** For each label the index of the copy of its feature the set keeps, -1 for a label the set keeps itself. */
  labelCopyOf = new Int32Array(0);
  /** The labels that are copies, in index order. */
  copyIndices: number[] = [];
  /** The per-frame records the shaders read (`LabelFrameRecordLayout`), the GPU staging. */
  frameRecords = new Float32Array(0);
  drawBatches: BaseLabelDrawBatch[] = [];

  /** The tile records in the set's order: a label's `tileSlots` entry indexes them. */
  get tileRecords(): readonly BaseLabelTileRecord[] {
    return this.records;
  }

  /** Each tile's labels as a run of the set, start and end pairs, in the set's order. */
  get tileRuns(): number[] {
    const runs: number[] = [];
    for (const record of this.records) runs.push(record.start, record.start + record.count);
    return runs;
  }

  reset(): void {
    this.records = [];
    this.resize(0);
    this.drawBatches = [];
    this.copyIndices = [];
  }

  /**
   * Lays the tiles of `sourceEntries` out end to end and rewrites every
   * per-label column from their label sets. A tile that stays with the same
   * resident is a run that survived: its old and new place go into the
   * change. A tile whose resident was replaced counts as new, so its labels
   * fade in like a fresh tile's.
   */
  repack(sourceEntries: readonly BaseLabelSourceEntry<LabelSourceTile>[]): LabelWorkingSetChange {
    const previousRecords = this.records;
    const previousIndexByOwner = new Map<string, number>();
    previousRecords.forEach((record, index) => previousIndexByOwner.set(ownerKeyString(record.ownerKey), index));
    const nextRecords: BaseLabelTileRecord[] = [];
    const moves: LabelBlockMove[] = [];
    const arrivedRuns: LabelRun[] = [];
    const survived = new Uint8Array(previousRecords.length);
    let start = 0;
    for (const entry of sourceEntries) {
      const count = entry.resident.textLabels.count;
      const previousIndex = previousIndexByOwner.get(ownerKeyString(entry.ownerKey));
      if (previousIndex !== undefined && previousRecords[previousIndex]!.resident === entry.resident) {
        survived[previousIndex] = 1;
        if (count > 0) moves.push({ oldStart: previousRecords[previousIndex]!.start, newStart: start, count });
      } else if (count > 0) {
        arrivedRuns.push([start, start + count]);
      }
      nextRecords.push({ ownerKey: entry.ownerKey, resident: entry.resident, start, count });
      start += count;
    }
    const departedRuns: LabelRun[] = [];
    previousRecords.forEach((record, index) => {
      if (survived[index] === 0 && record.count > 0) departedRuns.push([record.start, record.start + record.count]);
    });
    const previousKeys = this.keys;
    this.records = nextRecords;
    this.resize(start);
    this.rewriteLabelColumns();
    this.mergeRankOrder();
    this.markCopies();
    this.drawBatches = nextRecords.filter((r) => r.count > 0).map((r) => ({ gpu: r.resident.gpu, globalLabelStart: r.start, labelCount: r.count }));
    return new LabelWorkingSetChange(start, moves, departedRuns, arrivedRuns, previousKeys, this.keys);
  }

  /** Each label's shrink for its distance into the frame records, for the labels of `spans` (start and end pairs). */
  updatePerspectiveScales(scales: Float32Array, spans: ArrayLike<number>): void {
    const L = LabelFrameRecordLayout;
    const records = this.frameRecords;
    const count = this.labelCount;
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, count);
      for (let index = spans[s]!; index < end; index++) records[index * L.floats + L.perspectiveScale] = index < scales.length ? scales[index]! : 1;
    }
  }

  /**
   * Each label's fade alpha times `multiplier` into the frame records, for
   * the labels of `spans`. The rest are dark and keep the 0 they left with.
   */
  updateFadeAlphas(alphas: Float32Array, multiplier: number, spans: ArrayLike<number>): void {
    const L = LabelFrameRecordLayout;
    const records = this.frameRecords;
    const count = this.labelCount;
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, count);
      for (let index = spans[s]!; index < end; index++) records[index * L.floats + L.fadeAlpha] = index < alphas.length ? alphas[index]! * multiplier : 0;
    }
  }

  private resize(count: number): void {
    this.labelCount = count;
    this.tiles = new Int32Array(count * 3);
    this.tileSlots = new Int32Array(count);
    this.uv = new Float32Array(count * 2);
    this.roofHeight = new Float32Array(count);
    this.liftsToRoof = new Uint8Array(count);
    this.halfSizes = new Float32Array(count * 2);
    this.ranks = makeBaseLabelRanks(count);
    this.rankOrder = new Int32Array(count);
    this.keys = new BigUint64Array(count);
    this.presentation = emptyPresentation(count);
    this.labelCopyOf = new Int32Array(count).fill(-1);
    this.frameRecords = new Float32Array(count * LabelFrameRecordLayout.floats);
  }

  private rewriteLabelColumns(): void {
    const L = LabelFrameRecordLayout;
    this.records.forEach((record, slot) => {
      if (record.count === 0) return;
      const labels = record.resident.textLabels;
      const count = Math.min(record.count, labels.count);
      const s = record.start;
      const tile = record.ownerKey.tile;
      this.uv.set(labels.uv.subarray(0, count * 2), s * 2);
      this.roofHeight.set(labels.roofHeight.subarray(0, count), s);
      this.liftsToRoof.set(labels.liftsToRoof.subarray(0, count), s);
      this.ranks.priority.set(labels.ranks.priority.subarray(0, count), s);
      this.ranks.sortPriority.set(labels.ranks.sortPriority.subarray(0, count), s);
      this.ranks.keyHi.set(labels.ranks.keyHi.subarray(0, count), s);
      this.ranks.keyLo.set(labels.ranks.keyLo.subarray(0, count), s);
      this.keys.set(labels.keys.subarray(0, count), s);
      this.presentation.minCameraZoom.set(labels.minCameraZoom.subarray(0, count), s);
      this.presentation.maxCameraZoom.set(labels.maxCameraZoom.subarray(0, count), s);
      this.presentation.isLocal.set(labels.isLocal.subarray(0, count), s);
      for (let offset = 0; offset < count; offset++) {
        const index = s + offset;
        this.tiles[index * 3] = tile.z;
        this.tiles[index * 3 + 1] = tile.x;
        this.tiles[index * 3 + 2] = tile.y;
        this.tileSlots[index] = slot;
        const sx = labels.sizePoints[offset * 2]!;
        const sy = labels.sizePoints[offset * 2 + 1]!;
        this.halfSizes[index * 2] = sx * 0.5;
        this.halfSizes[index * 2 + 1] = sy * 0.5;
        const r = index * L.floats;
        this.frameRecords[r + L.perspectiveScale] = 1;
        this.frameRecords[r + L.sizeX] = sx;
        this.frameRecords[r + L.sizeY] = sy;
      }
    });
  }

  /** The tiles' rank orders laid end to end in the set's indices, then merged into one. */
  private mergeRankOrder(): void {
    for (const record of this.records) {
      if (record.count === 0) continue;
      const tileOrder = record.resident.textLabels.rankOrder;
      const count = Math.min(record.count, tileOrder.length);
      for (let offset = 0; offset < count; offset++) this.rankOrder[record.start + offset] = record.start + tileOrder[offset]!;
    }
    mergeRankRuns(this.rankOrder, this.tileRuns, this.ranks);
  }

  /**
   * Keeps the first copy of each feature in the set's order, the tiles being
   * in winner order, per world wrap, and points the later copies at it. A
   * label without a key is nobody's copy.
   */
  private markCopies(): void {
    this.copyIndices = [];
    const kept = new Map<number, Map<bigint, number>>();
    for (const record of this.records) {
      if (record.count === 0) continue;
      const wrap = record.ownerKey.worldWrap;
      let byKey = kept.get(wrap);
      if (byKey === undefined) kept.set(wrap, (byKey = new Map()));
      for (let index = record.start; index < record.start + record.count; index++) {
        const key = this.keys[index]!;
        if (key === 0n) continue;
        const keptIndex = byKey.get(key);
        if (keptIndex !== undefined) {
          this.labelCopyOf[index] = keptIndex;
          this.presentation.isCopy[index] = 1;
          this.copyIndices.push(index);
        } else {
          byKey.set(key, index);
        }
      }
    }
  }
}

function emptyPresentation(count: number): BaseLabelPresentation {
  return { minCameraZoom: new Float32Array(count), maxCameraZoom: new Float32Array(count), isLocal: new Uint8Array(count), isCopy: new Uint8Array(count) };
}
