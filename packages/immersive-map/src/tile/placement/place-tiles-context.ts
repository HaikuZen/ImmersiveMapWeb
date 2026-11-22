// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Tile, tileKey } from "../tile.ts";
import type { PlaceTile, ResidentTile } from "./place-tile.ts";

/** The logical tile layout a frame draws its ground, or its buildings, by: each resident tile and where it is placed. */
export interface PlaceTilesContext<R extends ResidentTile> {
  readonly tilePlacements: readonly PlaceTile<R>[];
}

const emptyContext: PlaceTilesContext<never> = Object.freeze({ tilePlacements: Object.freeze([]) });

export const PlaceTilesContext = {
  empty<R extends ResidentTile>(): PlaceTilesContext<R> {
    return emptyContext;
  },

  /**
   * The terrain each source's grid rises by, by the source's `tileKey`: the
   * finest of its placements' (`PlaceTile.displacement`), the heights what
   * stands on the ground is placed at. A source placed in its own slot and
   * as a stand-in rises by one terrain wherever it draws.
   */
  displacementBySource(placements: readonly PlaceTile<ResidentTile>[]): Map<string, Tile> {
    const terrains = new Map<string, Tile>();
    for (const placement of placements) {
      const terrain = placement.displacement;
      if (terrain === undefined) continue;
      const key = tileKey(placement.resident.tile);
      if (terrain.z > (terrains.get(key)?.z ?? -1)) terrains.set(key, terrain);
    }
    return terrains;
  },
} as const;
