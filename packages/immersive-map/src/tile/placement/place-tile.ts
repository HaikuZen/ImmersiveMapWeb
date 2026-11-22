// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { quartersAll } from "../tile-quarters.ts";
import { type Tile, tileKey } from "../tile.ts";

/**
 * A tile in a specific copy of the world. The flat map repeats the world
 * along x so the antimeridian is never an edge: `worldWrap` 0 is the world,
 * -1 the copy to its west, 1 the copy to its east.
 */
export interface VisibleTile {
  readonly tile: Tile;
  readonly worldWrap: number;
}

export function visibleTileKey(v: VisibleTile): string {
  return `${tileKey(v.tile)}@${v.worldWrap}`;
}

/** The ground of a raster placement: a texture of this many pixels a side. */
export interface RasterTileSpec {
  readonly size: number;
}

/**
 * How a placement draws: lines, labels, and the ground from a texture. A tile
 * in its own slot takes its slot's. A stand-in takes the rules of its own
 * slot when the frame has one, else the slot's it fills, so a pan changes
 * nothing on screen until the slot's own tile lands.
 */
export interface TileDrawRules {
  readonly drawsLines: boolean;
  readonly drawsLabels: boolean;
  /** The ground from a texture of this size, `undefined` for the geometry. */
  readonly raster: RasterTileSpec | undefined;
}

export const allDrawRules: TileDrawRules = { drawsLines: true, drawsLabels: true, raster: undefined };

/** The finer of two rules, switch by switch: geometry over a texture, the larger texture over the smaller. */
export function finerRules(mine: TileDrawRules, other: TileDrawRules): TileDrawRules {
  let raster: RasterTileSpec | undefined;
  if (mine.raster === undefined || other.raster === undefined) raster = undefined;
  else raster = mine.raster.size >= other.raster.size ? mine.raster : other.raster;
  return { drawsLines: mine.drawsLines || other.drawsLines, drawsLabels: mine.drawsLabels || other.drawsLabels, raster };
}

export function rulesKey(r: TileDrawRules): string {
  return `${r.drawsLines ? 1 : 0}${r.drawsLabels ? 1 : 0}${r.raster?.size ?? "-"}`;
}

/** What the planner needs of a resident tile: its identity. */
export interface ResidentTile {
  readonly tile: Tile;
}

/**
 * A tile drawn in a slot: the resident tile, where it is drawn (`placeIn`)
 * and the target it is drawn for (`slot`). They differ when an ancestor is
 * drawn in a finer target's slot, or a descendant stands in for a loading
 * ancestor.
 */
export interface PlaceTile<R extends ResidentTile> {
  readonly resident: R;
  readonly placeIn: VisibleTile;
  readonly slot: VisibleTile;
  readonly rules: TileDrawRules;
  /** The flat map's horizon backdrop: drawn under every placement, no ground of the planner's. */
  readonly isHorizonBackdrop: boolean;
  /** The terrain tile the ground shades its slopes by on the relief, `undefined` on the plane. */
  readonly terrain: Tile | undefined;
  /** The terrain tile the grid rises by, `terrain` or its ancestor at the displacement's zoom. */
  readonly displacement: Tile | undefined;
  /** The quarters the buildings and trees draw in, a bit per quarter. */
  readonly quarters: number;
}

export function makePlaceTile<R extends ResidentTile>(
  resident: R,
  placeIn: VisibleTile,
  options: {
    slot?: VisibleTile;
    rules?: TileDrawRules;
    isHorizonBackdrop?: boolean;
    terrain?: Tile | undefined;
    displacement?: Tile | undefined;
    quarters?: number;
  } = {},
): PlaceTile<R> {
  return {
    resident,
    placeIn,
    slot: options.slot ?? placeIn,
    rules: options.rules ?? allDrawRules,
    isHorizonBackdrop: options.isHorizonBackdrop ?? false,
    terrain: options.terrain,
    displacement: options.displacement ?? options.terrain,
    quarters: options.quarters ?? quartersAll,
  };
}

/** A placement is the tile where it is drawn: the slot is not part of its identity. */
export function placeTileKey(p: PlaceTile<ResidentTile>): string {
  return `${tileKey(p.resident.tile)}>${visibleTileKey(p.placeIn)}`;
}

/** The tile is drawn in its own slot, at its own extent. */
export function inOwnSlot(p: PlaceTile<ResidentTile>): boolean {
  const a = p.resident.tile;
  const b = p.placeIn.tile;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
