// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelSourceEntryTests` (a tile ranks its own
// labels once): the columns a tile's label set is laid out in when the tile
// is made.

import { describe, expect, test } from "vitest";
import type { TextLabelPlacementInput, TextLabelSetMeta } from "../../tile/store/prepared-labels.ts";
import { makeTileTextLabels } from "./tile-text-labels.ts";

function input(index: number, key: string, collisionPriority: number, extra: Partial<TextLabelPlacementInput> = {}): TextLabelPlacementInput {
  return {
    uv: [index * 0.1, index * 0.2],
    roofHeight: 0,
    liftsToRoof: false,
    key,
    sortKey: index,
    collisionPriority,
    labelSizePoints: [10 + index, 6],
    minCameraZoom: 0,
    maxCameraZoom: null,
    isLocal: false,
    ...extra,
  };
}

function meta(inputs: TextLabelPlacementInput[]): TextLabelSetMeta {
  return { placementInputs: inputs, glyphRunStyles: [], poiIconRunStyles: [], routeShieldRunStyles: [] };
}

describe("makeTileTextLabels", () => {
  test("each tile ranks its own labels once", () => {
    const labels = makeTileTextLabels(meta([input(0, "1", 5), input(1, "2", 1), input(2, "3", 3)]));
    expect(labels.count).toBe(3);
    expect(Array.from(labels.rankOrder)).toEqual([1, 2, 0]);
  });

  test("the placement records are laid out as columns", () => {
    const labels = makeTileTextLabels(
      meta([input(0, "10", 0), input(1, "18446744073709551615", 1, { roofHeight: 120, liftsToRoof: true, minCameraZoom: 14, maxCameraZoom: 18, isLocal: true })]),
    );
    expect(Array.from(labels.uv)).toEqual([0, 0, Math.fround(0.1), Math.fround(0.2)]);
    expect(Array.from(labels.sizePoints)).toEqual([10, 6, 11, 6]);
    expect(Array.from(labels.roofHeight)).toEqual([0, 120]);
    expect(Array.from(labels.liftsToRoof)).toEqual([0, 1]);
    expect(Array.from(labels.keys)).toEqual([10n, 0xffff_ffff_ffff_ffffn]);
    expect(Array.from(labels.ranks.keyHi)).toEqual([0, 0xffff_ffff]);
    expect(Array.from(labels.ranks.keyLo)).toEqual([10, 0xffff_ffff]);
    expect(Array.from(labels.minCameraZoom)).toEqual([0, 14]);
    expect(Array.from(labels.maxCameraZoom), "a null maximum is never").toEqual([Infinity, 18]);
    expect(Array.from(labels.isLocal)).toEqual([0, 1]);
  });

  test("a key that is no u64 is no key, and a priority past 32 bits is clamped", () => {
    const labels = makeTileTextLabels(meta([input(0, "not a key", 2 ** 40), input(1, "-3", -(2 ** 40))]));
    expect(Array.from(labels.keys)).toEqual([0n, 0n]);
    expect(Array.from(labels.ranks.priority)).toEqual([2147483647, -2147483648]);
  });
});
