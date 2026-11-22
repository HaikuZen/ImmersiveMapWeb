// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * B4 only: the TypeScript planner the measurement replaced with Rust/Wasm
 * (docs/benchmarks/B04-planner.md), kept so the benchmark can be rerun.
 *
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
 */

import { finerRules, makePlaceTile, type PlaceTile, placeTileKey, type ResidentTile, type TileDrawRules, type VisibleTile, visibleTileKey, allDrawRules } from "../../../../packages/immersive-map/src/tile/placement/place-tile.ts";
import { type Tile, tileKey, tileParentAt } from "../../../../packages/immersive-map/src/tile/tile.ts";

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

function children(tile: Tile): Tile[] {
  const x = tile.x * 2;
  const y = tile.y * 2;
  const z = tile.z + 1;
  return [
    { x, y, z },
    { x: x + 1, y, z },
    { x, y: y + 1, z },
    { x: x + 1, y: y + 1, z },
  ];
}

export function buildPlacements<R extends ResidentTile>(inputs: PlacementInputs<R>): PlaceTile<R>[] {
  const { targets, resident, backdropZoomLevel } = inputs;
  const descendantSearchDepth = inputs.descendantSearchDepth ?? Number.MAX_SAFE_INTEGER;
  const previous = inputs.previous ?? [];
  const slotRules = inputs.slotRules ?? (() => allDrawRules);
  const terrainOf = inputs.terrain ?? (() => undefined);
  const terrainResident = inputs.terrainResident ?? (() => true);

  // A stand-in that is a target itself draws by its own slot's rules.
  const targetSlots = new Set(targets.map(visibleTileKey));
  const rules = (source: Tile, slot: VisibleTile): TileDrawRules => {
    const own: VisibleTile = { tile: source, worldWrap: slot.worldWrap };
    return slotRules(targetSlots.has(visibleTileKey(own)) ? own : slot);
  };
  /** A resident tile ready in a slot of `slotZoom`: in, with its terrain in too, or none to rise by. */
  const ready = (tile: Tile, slotZoom: number): { resident: R; terrain: Tile | undefined; displacement: Tile | undefined } | undefined => {
    const r = resident.get(tileKey(tile));
    if (!r) return undefined;
    const key = terrainOf(tile, slotZoom);
    if (!key) return { resident: r, terrain: undefined, displacement: undefined };
    if (!terrainResident(key.terrain) || !terrainResident(key.displacement)) return undefined;
    return { resident: r, terrain: key.terrain, displacement: key.displacement };
  };

  // The ancestors of every resident tile: the descendant search descends only into branches that hold something.
  const branches = new Set<string>();
  for (const r of resident.values()) {
    let ancestor: Tile | undefined = r.tile;
    while (ancestor) {
      const key = tileKey(ancestor);
      if (branches.has(key)) break;
      branches.add(key);
      ancestor = ancestor.z > 0 ? tileParentAt(ancestor, ancestor.z - 1) : undefined;
    }
  }

  const descendants = (tile: Tile, slot: VisibleTile, depth: number): { placements: PlaceTile<R>[]; complete: boolean } => {
    const r = ready(tile, slot.tile.z);
    if (r) {
      const placeIn: VisibleTile = { tile, worldWrap: slot.worldWrap };
      return { placements: [makePlaceTile(r.resident, placeIn, { slot, rules: rules(tile, slot), terrain: r.terrain, displacement: r.displacement })], complete: true };
    }
    if (depth <= 0 || !branches.has(tileKey(tile))) return { placements: [], complete: false };
    const placements: PlaceTile<R>[] = [];
    let complete = true;
    for (const child of children(tile)) {
      const resolved = descendants(child, slot, depth - 1);
      placements.push(...resolved.placements);
      complete = complete && resolved.complete;
    }
    return { placements, complete };
  };

  const isUsefulSubstitute = (tile: Tile) => backdropZoomLevel === undefined || tile.z > backdropZoomLevel;

  const placeTiles: PlaceTile<R>[] = [];
  const seen = new Set<string>();
  const append = (p: PlaceTile<R>) => {
    const key = placeTileKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      placeTiles.push(p);
    }
  };

  // What the last frame showed and is still resident, by the ground it stood
  // on and under every ancestor of that ground, in the last frame's order.
  const shownByGround = new Map<string, PlaceTile<R>[]>();
  const shownInsideByAncestor = new Map<string, PlaceTile<R>[]>();
  for (const shown of previous) {
    const tile = shown.resident.tile;
    if (!resident.has(tileKey(tile)) || !isUsefulSubstitute(tile)) continue;
    if (shown.terrain && !terrainResident(shown.terrain)) continue;
    if (shown.displacement && !terrainResident(shown.displacement)) continue;
    const ground = shown.placeIn;
    const groundKey = visibleTileKey(ground);
    shownByGround.set(groundKey, [...(shownByGround.get(groundKey) ?? []), shown]);
    for (let z = ground.tile.z - 1; z >= 0; z--) {
      const ancestor = tileParentAt(ground.tile, z);
      if (!ancestor) break;
      const key = visibleTileKey({ tile: ancestor, worldWrap: ground.worldWrap });
      shownInsideByAncestor.set(key, [...(shownInsideByAncestor.get(key) ?? []), shown]);
    }
  }

  for (const target of targets) {
    const sourceTile = target.tile;
    const own = ready(sourceTile, sourceTile.z);
    if (own) {
      append(makePlaceTile(own.resident, target, { rules: slotRules(target), terrain: own.terrain, displacement: own.displacement }));
      continue;
    }
    // What stood on this ground last frame, by the ground it stood on, not by
    // its tile: a ground changes only to its own target. Each is drawn no
    // worse than it was shown and no worse than the slot asks.
    const shownInside = shownInsideByAncestor.get(visibleTileKey(target)) ?? [];
    let shownOver: PlaceTile<R> | undefined;
    for (let z = sourceTile.z; shownOver === undefined && z >= 0; z--) {
      const ground = tileParentAt(sourceTile, z);
      if (!ground) break;
      shownOver = shownByGround.get(visibleTileKey({ tile: ground, worldWrap: target.worldWrap }))?.[0];
    }
    for (const shown of shownInside) {
      const tile = shown.resident.tile;
      append(
        makePlaceTile(resident.get(tileKey(tile))!, shown.placeIn, {
          slot: target,
          rules: finerRules(shown.rules, rules(tile, target)),
          terrain: shown.terrain,
          displacement: shown.displacement,
        }),
      );
    }
    if (shownOver) {
      const tile = shownOver.resident.tile;
      append(
        makePlaceTile(resident.get(tileKey(tile))!, target, {
          rules: finerRules(shownOver.rules, rules(tile, target)),
          terrain: shownOver.terrain,
          displacement: shownOver.displacement,
        }),
      );
      continue;
    }
    // Ground nothing was shown on, or the holes between what was: the
    // descendants first where nothing at all was shown.
    if (shownInside.length === 0) {
      const below = descendantSearchDepth > 0 && branches.has(tileKey(sourceTile)) ? descendants(sourceTile, target, descendantSearchDepth) : { placements: [], complete: false };
      below.placements.forEach(append);
      if (below.complete && below.placements.length > 0) continue;
    }
    // The finest resident ancestor, drawn under them.
    for (let z = sourceTile.z - 1; z >= 0; z--) {
      const ancestor = tileParentAt(sourceTile, z);
      if (!ancestor || !isUsefulSubstitute(ancestor)) break;
      const r = ready(ancestor, sourceTile.z);
      if (r) {
        append(makePlaceTile(r.resident, target, { rules: rules(ancestor, target), terrain: r.terrain, displacement: r.displacement }));
        break;
      }
    }
  }
  return placeTiles;
}
