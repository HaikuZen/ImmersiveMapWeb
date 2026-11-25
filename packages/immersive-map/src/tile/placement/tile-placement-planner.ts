// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The frame's placements, a port of the Swift `TilePlacementPlanner`: a
 * function of the targets, of what is resident right now, and of what the
 * last frame showed. A resident target draws itself. A target not yet
 * resident draws its stand-ins:
 *
 * - first, what the last frame showed on its ground, while still resident:
 *   the ground keeps its tiles until the target itself lands, and a tile
 *   that arrives for a target the camera has left is never shown;
 * - where the last frame showed nothing, its resident descendants at any
 *   depth (a zoom-out keeps the detail it had until the parent arrives);
 * - wherever those leave a hole, its finest resident ancestor above the
 *   backdrop's zoom, placed whole: the placement prepass marks the finer
 *   over the coarser and the ground paints by equality, so the ancestor
 *   shows through the holes only;
 * - nothing when neither exists.
 *
 * On the relief a tile is resident with its terrain: the terrain it shades
 * by and rises by in a slot must be in too, or the tile is not placed there
 * and what stood on the ground stands on, by the terrain it was placed with.
 *
 * Targets may overlap, so one stand-in found for two targets is placed once.
 *
 * The planning itself runs in Rust/Wasm (crates/frame-wasm/src/planner.rs): this module lays the inputs out as flat arrays, and turns the
 * records back into placements of the caller's resident tiles.
 */

import { assertFrameWasm } from "../../frame/frame-wasm.ts";
import { planPlacements } from "../../wasm/frame_wasm/frame_wasm.js";
import { allDrawRules, makePlaceTile, type PlaceTile, type ResidentTile, type TileDrawRules, type VisibleTile } from "./place-tile.ts";
import { type Tile, tileKey } from "../tile.ts";

export interface PlacementInputs<R extends ResidentTile> {
  targets: readonly VisibleTile[];
  resident: ReadonlyMap<string, R>;
  /** The zoom of the full-screen backdrop already drawn under the main coverage, `undefined` without one. */
  backdropZoomLevel?: number | undefined;
  /** How many levels below a target the descendant search goes. 0 turns the descendant stand-ins off. */
  descendantSearchDepth?: number;
  previous?: readonly PlaceTile<R>[];
  slotRules?: (slot: VisibleTile) => TileDrawRules;
  /** The terrain a tile shades by and rises by in a slot of the zoom, `undefined` off the relief. */
  terrain?: (tile: Tile, slotZoom: number) => { terrain: Tile; displacement: Tile } | undefined;
  terrainResident?: (tile: Tile) => boolean;
}

/** Ints per target and per placement record (crates/frame-wasm/src/planner.rs). */
const TARGET_STRIDE = 7;
const PLACEMENT_STRIDE = 20;

function writeTile(out: Int32Array, at: number, tile: Tile | undefined): void {
  if (tile) {
    out[at] = tile.z;
    out[at + 1] = tile.x;
    out[at + 2] = tile.y;
  } else {
    out[at] = -1;
  }
}

function readTile(a: Int32Array, at: number): Tile | undefined {
  return a[at]! < 0 ? undefined : { z: a[at]!, x: a[at + 1]!, y: a[at + 2]! };
}

function writeRules(out: Int32Array, at: number, rules: TileDrawRules): void {
  out[at] = rules.drawsLines ? 1 : 0;
  out[at + 1] = rules.drawsLabels ? 1 : 0;
  out[at + 2] = rules.raster?.size ?? -1;
}

/** One rules object per distinct value: a frame has a handful. */
const rulesCache = new Map<number, TileDrawRules>();
function readRules(a: Int32Array, at: number): TileDrawRules {
  const lines = a[at]! !== 0;
  const labels = a[at + 1]! !== 0;
  const raster = a[at + 2]!;
  const key = (raster + 1) * 4 + (lines ? 2 : 0) + (labels ? 1 : 0);
  let rules = rulesCache.get(key);
  if (!rules) {
    rules = lines && labels && raster < 0 ? allDrawRules : { drawsLines: lines, drawsLabels: labels, raster: raster < 0 ? undefined : { size: raster } };
    rulesCache.set(key, rules);
  }
  return rules;
}

export function buildPlacements<R extends ResidentTile>(inputs: PlacementInputs<R>): PlaceTile<R>[] {
  assertFrameWasm();
  const { targets, resident } = inputs;
  const previous = inputs.previous ?? [];
  const slotRules = inputs.slotRules ?? (() => allDrawRules);

  const targetArray = new Int32Array(targets.length * TARGET_STRIDE);
  targets.forEach((t, i) => {
    const at = i * TARGET_STRIDE;
    writeTile(targetArray, at, t.tile);
    targetArray[at + 3] = t.worldWrap;
    writeRules(targetArray, at + 4, slotRules(t));
  });
  const residentArray = new Int32Array(resident.size * 3);
  let r = 0;
  for (const tile of resident.values()) writeTile(residentArray, 3 * r++, tile.tile);
  const previousArray = new Int32Array(previous.length * PLACEMENT_STRIDE);
  previous.forEach((p, i) => {
    const at = i * PLACEMENT_STRIDE;
    writeTile(previousArray, at, p.resident.tile);
    writeTile(previousArray, at + 3, p.placeIn.tile);
    previousArray[at + 6] = p.placeIn.worldWrap;
    writeTile(previousArray, at + 7, p.slot.tile);
    previousArray[at + 10] = p.slot.worldWrap;
    writeRules(previousArray, at + 11, p.rules);
    writeTile(previousArray, at + 14, p.terrain);
    writeTile(previousArray, at + 17, p.displacement);
  });

  const terrainOf = inputs.terrain;
  const terrainResident = inputs.terrainResident;
  const relief = terrainOf !== undefined && terrainResident !== undefined;
  const records = planPlacements(
    targetArray,
    residentArray,
    previousArray,
    inputs.backdropZoomLevel ?? -1,
    inputs.descendantSearchDepth ?? -1,
    relief
      ? (z: number, x: number, y: number, slotZoom: number) => {
          const key = terrainOf({ z, x, y }, slotZoom);
          return key ? new Int32Array([key.terrain.z, key.terrain.x, key.terrain.y, key.displacement.z, key.displacement.x, key.displacement.y]) : undefined;
        }
      : undefined,
    relief ? (z: number, x: number, y: number) => terrainResident({ z, x, y }) : undefined,
  );

  const placements: PlaceTile<R>[] = [];
  for (let at = 0; at < records.length; at += PLACEMENT_STRIDE) {
    const source = readTile(records, at)!;
    const tile = resident.get(tileKey(source));
    if (!tile) continue;
    const placeIn: VisibleTile = { tile: readTile(records, at + 3)!, worldWrap: records[at + 6]! };
    const slot: VisibleTile = { tile: readTile(records, at + 7)!, worldWrap: records[at + 10]! };
    placements.push(makePlaceTile(tile, placeIn, { slot, rules: readRules(records, at + 11), terrain: readTile(records, at + 14), displacement: readTile(records, at + 17) }));
  }
  return placements;
}
