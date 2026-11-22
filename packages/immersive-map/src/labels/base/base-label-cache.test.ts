// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelSourceEntryTests` (the cache part): the
// cache reads each tile's one label set, ranks the set by merging its tiles'
// orders, and keeps one copy of a feature from the preferred tile.

import { describe, expect, test } from "vitest";
import { makePlaceTile } from "../../tile/placement/place-tile.ts";
import type { GpuTile } from "../../tile/store/tile-gpu.ts";
import type { TextLabelPlacementInput } from "../../tile/store/prepared-labels.ts";
import { sortedRankOrder } from "../collisions/base-label-rank.ts";
import { BaseLabelCache, LabelFrameRecordLayout, type LabelSourceTile } from "./base-label-cache.ts";
import { buildBaseLabelSourceEntries } from "./base-label-source-entry.ts";
import { makeTileTextLabels } from "./tile-text-labels.ts";

/** A tile of labels keyed `keys`, the label at index i of priority `priorities[i]` (i by default), sort key i and size (10 + i, 6). */
function sourceTile(x: number, y: number, z: number, keys: number[], priorities?: number[]): LabelSourceTile {
  const placementInputs: TextLabelPlacementInput[] = keys.map((key, index) => ({
    uv: [index, index],
    roofHeight: 0,
    liftsToRoof: false,
    key: String(key),
    sortKey: index,
    collisionPriority: priorities?.[index] ?? index,
    labelSizePoints: [10 + index, 6],
    minCameraZoom: 0,
    maxCameraZoom: null,
    isLocal: false,
  }));
  const meta = { placementInputs, glyphRunStyles: [], poiIconRunStyles: [], routeShieldRunStyles: [] };
  return { tile: { x, y, z }, gpu: { meta: { labels: meta } } as unknown as GpuTile, textLabels: makeTileTextLabels(meta) };
}

function placeIn(x: number, y: number, z: number, worldWrap = 0) {
  return { tile: { x, y, z }, worldWrap };
}

function ownEntry(tile: LabelSourceTile) {
  return buildBaseLabelSourceEntries([makePlaceTile(tile, placeIn(tile.tile.x, tile.tile.y, tile.tile.z))]);
}

describe("BaseLabelCache", () => {
  test("the cache reads the tile's label set", () => {
    const cache = new BaseLabelCache();
    cache.repack(ownEntry(sourceTile(8, 8, 4, [10, 11, 12])));
    expect(cache.labelCount).toBe(3);
    expect(Array.from(cache.keys)).toEqual([10n, 11n, 12n]);
    expect(Array.from(cache.tiles.subarray(0, 3)), "z, x, y").toEqual([4, 8, 8]);
  });

  test("the cache writes stable collision metadata", () => {
    const cache = new BaseLabelCache();
    cache.repack(ownEntry(sourceTile(8, 8, 4, [10, 11])));
    expect(Array.from(cache.ranks.priority)).toEqual([0, 1]);
    expect(Array.from(cache.ranks.sortPriority)).toEqual([0, 1]);
    expect(Array.from(cache.ranks.keyLo)).toEqual([10, 11]);
    expect(Array.from(cache.halfSizes)).toEqual([5, 3, 5.5, 3]);
    const L = LabelFrameRecordLayout;
    expect(cache.frameRecords[L.perspectiveScale]).toBe(1);
    expect(cache.frameRecords[L.floats + L.sizeX]).toBe(11);
    expect(cache.frameRecords[L.floats + L.sizeY]).toBe(6);
  });

  // The set's rank order is its tiles' orders merged: the same order a sort
  // of the whole set gives, ties to the earlier tile.
  test("the set's rank order is its tiles' orders merged", () => {
    const first = sourceTile(8, 8, 4, [1, 2, 3], [5, 1, 3]);
    const second = sourceTile(9, 8, 4, [4, 5, 6], [2, 4, 0]);
    const entries = buildBaseLabelSourceEntries([makePlaceTile(first, placeIn(8, 8, 4)), makePlaceTile(second, placeIn(9, 8, 4))]);
    const cache = new BaseLabelCache();
    cache.repack(entries);

    expect(Array.from(cache.keys)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(Array.from(first.textLabels.rankOrder), "each tile ranks its own labels once").toEqual([1, 2, 0]);
    expect(Array.from(cache.rankOrder)).toEqual([5, 1, 3, 2, 4, 0]);
    expect(Array.from(cache.rankOrder)).toEqual(Array.from(sortedRankOrder(cache.ranks, cache.labelCount)));
  });

  // The exact tile and the coarser one standing in beside it both bring
  // feature 20: the set keeps the exact tile's copy, the source it prefers,
  // and marks the stand-in's as its copy, wherever either draws.
  test("the cache keeps one copy of a feature from the preferred tile", () => {
    const exact = sourceTile(9652, 12318, 15, [10, 20]);
    const standIn = sourceTile(2413, 3079, 13, [20, 30, 0, 0]);
    const entries = buildBaseLabelSourceEntries([makePlaceTile(standIn, placeIn(9653, 12318, 15)), makePlaceTile(exact, placeIn(9652, 12318, 15))]);
    const cache = new BaseLabelCache();
    cache.repack(entries);

    expect(Array.from(cache.keys), "the exact tile leads the set").toEqual([10n, 20n, 20n, 30n, 0n, 0n]);
    expect(Array.from(cache.labelCopyOf), "the stand-in's copy points at the exact tile's, a label without a key is nobody's copy").toEqual([-1, -1, 1, -1, -1, -1]);
    expect(cache.copyIndices).toEqual([2]);
    expect(Array.from(cache.presentation.isCopy, Boolean)).toEqual([false, false, true, false, false, false]);
  });

  // When the exact tile leaves, the stand-in's copy is the one the set keeps.
  test("the copy is kept once the preferred tile leaves", () => {
    const exact = sourceTile(9652, 12318, 15, [20]);
    const standIn = sourceTile(2413, 3079, 13, [20]);
    const both = buildBaseLabelSourceEntries([makePlaceTile(exact, placeIn(9652, 12318, 15)), makePlaceTile(standIn, placeIn(9653, 12318, 15))]);
    const standInOnly = buildBaseLabelSourceEntries([makePlaceTile(standIn, placeIn(9653, 12318, 15))]);
    const cache = new BaseLabelCache();

    cache.repack(both);
    expect(Array.from(cache.labelCopyOf)).toEqual([-1, 0]);
    cache.repack(standInOnly);
    expect(Array.from(cache.labelCopyOf)).toEqual([-1]);
    expect(cache.copyIndices).toEqual([]);
  });

  // One tile in two world wraps is one feature in two places: both kept.
  test("the same feature in two world wraps is not a copy", () => {
    const tile = sourceTile(1, 1, 2, [20]);
    const entries = buildBaseLabelSourceEntries([makePlaceTile(tile, placeIn(1, 1, 2, 0)), makePlaceTile(tile, placeIn(1, 1, 2, 1))]);
    const cache = new BaseLabelCache();
    cache.repack(entries);
    expect(Array.from(cache.keys)).toEqual([20n, 20n]);
    expect(Array.from(cache.labelCopyOf)).toEqual([-1, -1]);
  });

  test("a repack hands back the runs that survived, left and arrived", () => {
    const a = sourceTile(8, 8, 4, [1, 2]);
    const b = sourceTile(9, 8, 4, [3]);
    const c = sourceTile(8, 9, 4, [4, 5, 6]);
    const cache = new BaseLabelCache();
    cache.repack(buildBaseLabelSourceEntries([makePlaceTile(a, placeIn(8, 8, 4)), makePlaceTile(b, placeIn(9, 8, 4))]));
    const change = cache.repack(buildBaseLabelSourceEntries([makePlaceTile(a, placeIn(8, 8, 4)), makePlaceTile(c, placeIn(8, 9, 4))]));
    expect(change.count).toBe(5);
    expect(change.moves).toEqual([{ oldStart: 0, newStart: 0, count: 2 }]);
    expect(change.departedRuns).toEqual([[2, 3]]);
    expect(change.arrivedRuns).toEqual([[2, 5]]);
    expect(Array.from(change.previousKeys)).toEqual([1n, 2n, 3n]);
    expect(Array.from(change.keys)).toEqual([1n, 2n, 4n, 5n, 6n]);
    expect(cache.tileRuns).toEqual([0, 2, 2, 5]);
    expect(cache.drawBatches.map((batch) => [batch.globalLabelStart, batch.labelCount])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  test("a tile whose resident was replaced counts as new", () => {
    const cache = new BaseLabelCache();
    cache.repack(ownEntry(sourceTile(8, 8, 4, [1])));
    const change = cache.repack(ownEntry(sourceTile(8, 8, 4, [1])));
    expect(change.moves).toEqual([]);
    expect(change.departedRuns).toEqual([[0, 1]]);
    expect(change.arrivedRuns).toEqual([[0, 1]]);
  });

  test("the frame records take the spans' scales and fades, the rest stay dark", () => {
    const cache = new BaseLabelCache();
    cache.repack(ownEntry(sourceTile(8, 8, 4, [1, 2, 3])));
    cache.updatePerspectiveScales(Float32Array.from([0.5, 0.75]), [1, 3]);
    cache.updateFadeAlphas(Float32Array.from([1, 1, 0.5]), 0.5, [1, 3]);
    const L = LabelFrameRecordLayout;
    const scales = [0, 1, 2].map((index) => cache.frameRecords[index * L.floats + L.perspectiveScale]);
    const fades = [0, 1, 2].map((index) => cache.frameRecords[index * L.floats + L.fadeAlpha]);
    expect(scales, "a label past the scales keeps the full size").toEqual([1, 0.75, 1]);
    expect(fades).toEqual([0, 0.5, 0.25]);
  });
});
