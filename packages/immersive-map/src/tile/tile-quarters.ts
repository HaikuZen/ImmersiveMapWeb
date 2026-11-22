// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The four quarters of a tile: the squares of its four children. A tile
 * coarser than the tileset's deepest zoom keeps its buildings and trees
 * quarter by quarter, so the frame draws a quarter where its child is not
 * there to. Numbered by where a quarter lies in tile space, x east and y
 * south: 0 north-west, 1 north-east, 2 south-west, 3 south-east.
 */

import type { Tile } from "./tile.ts";

export const quarterCount = 4;
/** Every quarter: the mask a whole tile draws with. */
export const quartersAll = 0b1111;

export function quarterChild(tile: Tile, quarter: number): Tile {
  return { x: tile.x * 2 + (quarter & 1), y: tile.y * 2 + (quarter >> 1), z: tile.z + 1 };
}

/**
 * The runs of `starts` (five quarter starts, the last the count) that `mask`
 * draws, consecutive quarters joined. Empty `starts` is a tile kept whole.
 */
export function quarterRuns(starts: readonly number[], whole: readonly [number, number], mask: number): [number, number][] {
  if (starts.length !== quarterCount + 1) return mask === quartersAll ? [[whole[0], whole[1]]] : [];
  const runs: [number, number][] = [];
  for (let q = 0; q < quarterCount; q++) {
    if ((mask & (1 << q)) === 0) continue;
    const start = starts[q]!;
    const end = starts[q + 1]!;
    if (end <= start) continue;
    const last = runs.at(-1);
    if (last && last[1] === start) last[1] = end;
    else runs.push([start, end]);
  }
  return runs;
}
