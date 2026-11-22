// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type CoverageSettings, resolvedMaximumZoomLevel } from "../../configuration/tile-settings.ts";
import { quarterChild, quarterCount, quartersAll } from "../tile-quarters.ts";
import { tileKey, tileParentAt } from "../tile.ts";
import { makePlaceTile, type PlaceTile, type ResidentTile, type VisibleTile, visibleTileKey } from "./place-tile.ts";
import { PlaceTilesContext } from "./place-tiles-context.ts";

/** What the building coverage needs of a resident tile past its identity. */
export interface BuildingSourceTile extends ResidentTile {
  /**
   * Whether the tile keeps its buildings by quarters (`TileQuarters`), as a
   * tile coarser than the tileset's deepest zoom does: the Swift engine's
   * non-empty `extruded.quarterIndexStarts`.
   */
  readonly keepsBuildingsByQuarters: boolean;
}

/** The settings `minimumDrawZoom` reads. Structural, so `ImmersiveMapSettings` passes. */
export interface BuildingDrawZoomSettings {
  readonly scene: { readonly extrusion: { readonly buildingsMinimumZoom: number } };
  readonly tiles: { readonly coverage: CoverageSettings };
}

/**
 * The coarsest tile zoom whose buildings are drawn. A tile coarser than the
 * tileset's deepest zoom ships them merged into groups of one height, each
 * polygon standing at its group's height. Coarser than this, the groups are
 * too rough to stand.
 */
const minimumSourceZoom = 14;

/**
 * The flat map's building coverage: which tiles draw their buildings this
 * frame.
 *
 * The buildings follow the ground. Every tile the ground shows this frame
 * (`buildPlacements`), in its own slot or standing in, whose zoom is the
 * buildings' zoom or finer (`minimumDrawZoom`), draws its buildings in its
 * own square: a tile's buildings are cut at its edges by the parser, so
 * tiles of different zooms side by side draw each building once. Where two
 * of them overlap (a tile standing in for its loading children over ground
 * some of them already show, a far ring's coarse tile reaching under a
 * nearer ring's finer tiles) the finer one draws: a tile coarser than the
 * tileset's deepest zoom keeps its buildings and its trees by quarters, each
 * cut at the quarters' edges as its children cut theirs (`TileQuarters`),
 * and draws only the quarters whose child is not there
 * (`PlaceTile.quarters`). So the finest buildings the ground has stand, a
 * building never draws twice, and no ground the coarse tile covers is left
 * without them. A tile kept whole that a finer tile lies under draws whole
 * and the finer one waits, as does a tile under a coarser one's drawn
 * quarter, which happens only with a tileset two zooms deeper than the
 * buildings start. The planner never demands a tile, and keeps no field of
 * its own: how far the buildings reach is how far the ground's rings place
 * tiles of the buildings' zoom, so the camera's tilt changes which tiles are
 * in view and never which tile a building is drawn from.
 */
export const BuildingCoveragePlanner = {
  minimumSourceZoom,

  /**
   * The tile zoom the buildings draw from: the zoom of the tiles a camera at
   * `ExtrusionSettings.buildingsMinimumZoom` targets, within the tileset's
   * zooms and never coarser than `minimumSourceZoom`. The parser extrudes no
   * coarser tile.
   */
  minimumDrawZoom(settings: BuildingDrawZoomSettings): number {
    const minimumZoom = settings.scene.extrusion.buildingsMinimumZoom;
    const wanted = Number.isFinite(minimumZoom) ? Math.floor(Math.max(minimumZoom, 0)) : Number.MAX_SAFE_INTEGER;
    return Math.max(minimumSourceZoom, Math.min(wanted, resolvedMaximumZoomLevel(settings.tiles.coverage)));
  },

  /**
   * `groundPlacements` are the frame's ground placements (`buildPlacements`).
   * `onFlatMap` is false on the globe, where nothing is extruded.
   * `minimumZoom` is the tile zoom the buildings draw from
   * (`minimumDrawZoom`).
   */
  plan<R extends BuildingSourceTile>(groundPlacements: readonly PlaceTile<R>[], onFlatMap: boolean, minimumZoom: number = minimumSourceZoom): PlaceTilesContext<R> {
    if (!onFlatMap) return PlaceTilesContext.empty();
    const floorZoom = Math.max(minimumZoom, minimumSourceZoom);
    // The buildings rise by the terrain their ground's grid does.
    const displacementBySource = PlaceTilesContext.displacementBySource(groundPlacements);
    // The tiles the ground shows, by the world copy they show in.
    const sources = new Map<string, { readonly square: VisibleTile; readonly resident: R }>();
    for (const placement of groundPlacements) {
      if (placement.resident.tile.z < floorZoom) continue;
      const square: VisibleTile = { tile: placement.resident.tile, worldWrap: placement.placeIn.worldWrap };
      sources.set(visibleTileKey(square), { square, resident: placement.resident });
    }
    // From the coarsest down, so a tile knows what its ancestors draw: the
    // ground a tile drawn whole takes, and the squares of the quarters drawn.
    const takenWhole = new Set<string>();
    const takenQuarters = new Set<string>();
    const result: PlaceTile<R>[] = [];
    const ordered = [...sources.values()].sort((lhs, rhs) => lhs.square.tile.z - rhs.square.tile.z);
    for (const { square, resident } of ordered) {
      let isTaken = false;
      for (let zoom = square.tile.z - 1; zoom >= floorZoom && !isTaken; zoom--) {
        const ancestor = tileParentAt(square.tile, zoom);
        if (ancestor === undefined) continue;
        const ground = visibleTileKey({ tile: ancestor, worldWrap: square.worldWrap });
        isTaken = takenWhole.has(ground) || takenQuarters.has(ground);
      }
      if (isTaken) continue;
      let quarters = quartersAll;
      if (!resident.keepsBuildingsByQuarters) {
        takenWhole.add(visibleTileKey(square));
      } else {
        // A quarter whose child the ground shows is the child's.
        for (let quarter = 0; quarter < quarterCount; quarter++) {
          const child = visibleTileKey({ tile: quarterChild(square.tile, quarter), worldWrap: square.worldWrap });
          if (sources.has(child)) quarters &= ~(1 << quarter);
          else takenQuarters.add(child);
        }
        if (quarters === 0) continue;
      }
      result.push(makePlaceTile(resident, square, { displacement: displacementBySource.get(tileKey(resident.tile)), quarters }));
    }
    result.sort((lhs, rhs) => {
      const a = lhs.placeIn;
      const b = rhs.placeIn;
      if (a.worldWrap !== b.worldWrap) return a.worldWrap - b.worldWrap;
      if (a.tile.z !== b.tile.z) return a.tile.z - b.tile.z;
      if (a.tile.x !== b.tile.x) return a.tile.x - b.tile.x;
      return a.tile.y - b.tile.y;
    });
    return { tilePlacements: result };
  },
} as const;
