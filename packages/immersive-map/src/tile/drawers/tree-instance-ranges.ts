// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { quarterCount, quartersAll } from "../tile-quarters.ts";

/**
 * Which of a tile's trees draw this frame, a port of the Swift
 * `TreeDrawer.Item.instanceRanges`: the first `share` of each quarter run of
 * `starts` that `quarters` draws, a quarter at a time and never joined (each
 * is thinned on its own), at least one tree of a run that has any. A
 * quarter's trees are sorted by priority, so a prefix thins them evenly.
 * Without quarter starts the tile's trees are one run, drawn only by a whole
 * tile. `count` is the tile's trees. The ranges are half-open `[start, end)`.
 */
export function treeInstanceRanges(count: number, starts: readonly number[], quarters: number, share: number): [number, number][] {
  const runs: [number, number][] = [];
  if (starts.length === quarterCount + 1) {
    for (let quarter = 0; quarter < quarterCount; quarter++) {
      if ((quarters & (1 << quarter)) !== 0) runs.push([starts[quarter]!, starts[quarter + 1]!]);
    }
  } else if (quarters === quartersAll) {
    runs.push([0, count]);
  }
  const ranges: [number, number][] = [];
  for (const [start, end] of runs) {
    const length = end - start;
    if (length <= 0) continue;
    const drawn = Math.min(length, Math.max(Math.ceil(Math.fround(length * Math.fround(share))), 1));
    ranges.push([start, start + drawn]);
  }
  return ranges;
}

/**
 * The share of the model's height its crown's centre stands at, and of its
 * radius the crown spans: what a tree's shadow disc is sized by. The model's
 * crown fills the upper two thirds of its height, over a trunk a third of it.
 */
export const TreeCrown = {
  centreHeightShare: 0.62,
  radiusShare: 0.9,
} as const;
