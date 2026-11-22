// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Tile, tileParentAt } from "../tile.ts";
import { type PlaceTile, type ResidentTile, type VisibleTile, visibleTileKey } from "./place-tile.ts";

/**
 * A ground source as the ground draws it: the tile, the world copy, and the
 * terrain its grid rises by (`PlaceTile.displacement`), `undefined` on the
 * plane.
 */
export interface PlacementGroundSource {
  readonly tile: Tile;
  readonly worldWrap: number;
  readonly displacement: Tile | undefined;
}

/**
 * The frame's ground, each point once: every placement's square
 * (`PlaceTile.placeIn`) less the finer squares inside it, which the planner
 * gives to the finer placements, the rest split into the largest
 * descendants that hold none of them. Placements overlap on the ground (a
 * finer one inside a coarser one, a child target under its parent), and
 * whatever has to draw the ground once per point, with no two placements
 * claiming the same ground, draws these squares: the placement prepass's
 * depth on the relief and the mountains' shadow casters. Placements sharing
 * a square take it once, from the last one, as the last mark of a square is
 * the one the stencil keeps.
 */
export interface PlacementGroundSquare {
  readonly source: PlacementGroundSource;
  /** The source's tile itself or a square inside it. */
  readonly square: VisibleTile;
}

export const PlacementGroundSquare = {
  /**
   * The terrain each source rises by wherever it draws, by the source's
   * `visibleTileKey` (its tile and world copy): the finest of its
   * placements' (`PlaceTile.displacement`).
   */
  displacements(placements: readonly PlaceTile<ResidentTile>[]): Map<string, Tile> {
    const terrains = new Map<string, Tile>();
    for (const placement of placements) {
      const terrain = placement.displacement;
      if (terrain === undefined) continue;
      const source = visibleTileKey({ tile: placement.resident.tile, worldWrap: placement.placeIn.worldWrap });
      if (terrain.z > (terrains.get(source)?.z ?? -1)) terrains.set(source, terrain);
    }
    return terrains;
  },

  /** The squares of a frame's placements, each point of the ground in exactly one. */
  squares(placements: readonly PlaceTile<ResidentTile>[]): PlacementGroundSquare[] {
    const displacements = PlacementGroundSquare.displacements(placements);
    // The last placement of a square owns it.
    const owners = new Map<string, PlaceTile<ResidentTile>>();
    for (const placement of placements) owners.set(visibleTileKey(placement.placeIn), placement);
    if (owners.size === 0) return [];
    let shallowest = Number.POSITIVE_INFINITY;
    for (const placement of owners.values()) shallowest = Math.min(shallowest, placement.placeIn.tile.z);
    // Every square with a finer square inside it.
    const holdsFiner = new Set<string>();
    for (const placement of owners.values()) {
      const square = placement.placeIn;
      for (let zoom = square.tile.z - 1; zoom >= shallowest; zoom--) {
        const ancestor = tileParentAt(square.tile, zoom);
        if (ancestor === undefined) break;
        const key = visibleTileKey({ tile: ancestor, worldWrap: square.worldWrap });
        if (holdsFiner.has(key)) break;
        holdsFiner.add(key);
      }
    }
    const squares: PlacementGroundSquare[] = [];
    for (const placement of owners.values()) {
      const tile = placement.resident.tile;
      const wrap = placement.placeIn.worldWrap;
      const source: PlacementGroundSource = {
        tile,
        worldWrap: wrap,
        displacement: displacements.get(visibleTileKey({ tile, worldWrap: wrap })) ?? placement.displacement,
      };
      const pending: VisibleTile[] = [placement.placeIn];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (!holdsFiner.has(visibleTileKey(next))) {
          squares.push({ source, square: next });
          continue;
        }
        const child = next.tile.z + 1;
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const part: VisibleTile = { tile: { x: next.tile.x * 2 + dx, y: next.tile.y * 2 + dy, z: child }, worldWrap: wrap };
            // A finer placement's own square is its to take.
            if (!owners.has(visibleTileKey(part))) pending.push(part);
          }
        }
      }
    }
    return squares;
  },

  /**
   * The cells a side a square takes of its source's grid of `sourceCells`,
   * on the same lines: the source's cells over the part of it the square is,
   * one at the least.
   */
  cells(sourceCells: number, sourceZoom: number, squareZoom: number): number {
    return Math.max(1, sourceCells >> Math.max(0, squareZoom - sourceZoom));
  },
} as const;
