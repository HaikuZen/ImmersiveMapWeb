// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { inOwnSlot, type PlaceTile, type ResidentTile, type VisibleTile } from "../../tile/placement/place-tile.ts";
import { tileKey } from "../../tile/tile.ts";

/**
 * A tile whose labels the frame shows, once per world copy (the Swift
 * `BaseLabelSourceEntry`): the resident tile, the world copy it is placed
 * in, and whether some placement draws it in its own slot. The base and the
 * road label caches read the same entries.
 */
export interface BaseLabelSourceEntry<R extends ResidentTile> {
  /** The resident's own tile in the placement's world copy. */
  readonly ownerKey: VisibleTile;
  readonly resident: R;
  /** The source is drawn in its own slot somewhere on screen. */
  readonly inOwnSlot: boolean;
}

/** The key an owner is kept under. */
export function ownerKeyString(owner: VisibleTile): string {
  return `${tileKey(owner.tile)}@${owner.worldWrap}`;
}

/** A source drawn in its own slot outranks one standing in for another target. */
export function sourcePriorityRank(entry: { readonly inOwnSlot: boolean }): number {
  return entry.inOwnSlot ? 0 : 1;
}

/** Winner order: own slot first, then the finer tile, then x, y and the world copy. */
export function sortForWinnerPriority<R extends ResidentTile>(lhs: BaseLabelSourceEntry<R>, rhs: BaseLabelSourceEntry<R>): boolean {
  const lp = sourcePriorityRank(lhs);
  const rp = sourcePriorityRank(rhs);
  if (lp !== rp) return lp < rp;
  const a = lhs.ownerKey;
  const b = rhs.ownerKey;
  if (a.tile.z !== b.tile.z) return a.tile.z > b.tile.z;
  if (a.tile.x !== b.tile.x) return a.tile.x < b.tile.x;
  if (a.tile.y !== b.tile.y) return a.tile.y < b.tile.y;
  return a.worldWrap < b.worldWrap;
}

/**
 * The frame's label sources from its placements: one entry per resident
 * tile and world copy, the entry that is in its own slot preferred, in
 * winner order.
 */
export function buildBaseLabelSourceEntries<R extends ResidentTile>(placements: readonly PlaceTile<R>[]): BaseLabelSourceEntry<R>[] {
  const best = new Map<string, BaseLabelSourceEntry<R>>();
  for (const placement of placements) {
    const entry: BaseLabelSourceEntry<R> = {
      ownerKey: { tile: placement.resident.tile, worldWrap: placement.placeIn.worldWrap },
      resident: placement.resident,
      inOwnSlot: inOwnSlot(placement),
    };
    const key = ownerKeyString(entry.ownerKey);
    const existing = best.get(key);
    if (existing === undefined || sortForWinnerPriority(entry, existing)) best.set(key, entry);
  }
  return [...best.values()].sort((lhs, rhs) => (sortForWinnerPriority(lhs, rhs) ? -1 : sortForWinnerPriority(rhs, lhs) ? 1 : 0));
}

/**
 * Whether two source lists are the same tiles in the same order, each the
 * same resident with the same slot ownership: the topology the label caches
 * are packed for (the Swift `BaseLabelSourceEntry.makeHash`, compared
 * exactly here rather than hashed).
 */
export function sameSourceEntries<R extends ResidentTile>(a: readonly BaseLabelSourceEntry<R>[], b: readonly BaseLabelSourceEntry<R>[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const x = a[index]!;
    const y = b[index]!;
    if (x.resident !== y.resident || x.inOwnSlot !== y.inOwnSlot || x.ownerKey.worldWrap !== y.ownerKey.worldWrap) return false;
    const t = x.ownerKey.tile;
    const u = y.ownerKey.tile;
    if (t.x !== u.x || t.y !== u.y || t.z !== u.z) return false;
  }
  return true;
}
