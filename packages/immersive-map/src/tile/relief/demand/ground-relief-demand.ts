// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2 } from "../../../math/vec.ts";
import type { PlaceTile, ResidentTile, VisibleTile } from "../../placement/place-tile.ts";
import { type Tile, tileKey, tileParentAt } from "../../tile.ts";
import type { GroundReliefTerrainZooms } from "./ground-relief-terrain-zooms.ts";

export interface GroundReliefDemandInput {
  readonly targets: readonly VisibleTile[];
  readonly shown: readonly PlaceTile<ResidentTile>[];
  readonly also?: readonly Tile[];
  readonly centerWorldMercator: Vec2;
  readonly zooms: GroundReliefTerrainZooms;
  readonly maximumTargetZoom?: number;
  readonly terrainSource: (tile: Tile, targetZoom: number) => { terrain: Tile; displacement: Tile };
}

/**
 * The terrain a frame needs, nearest first, a port of the Swift
 * `GroundReliefDemand`: what the frame asks the store for once, as it asks
 * for its map tiles, and what the store keeps. First the camera's map
 * around the point it looks at (`GroundReliefTerrainZooms.cameraZoom`),
 * which the camera's terrain follow reads. Then the terrain of every
 * target, by its distance from that point: the ring's terrain over the
 * target's tile and the one it displaces by, demanded with the tile so they
 * load side by side. Then the terrain the placements shown rise by, in
 * already, kept for as long as they stand. Last, the terrain the planner
 * wanted and found out (`also`). Nothing else.
 *
 * A frame past the relief's zooms, collapsed into the plane, asks for the
 * terrain the relief would read when it rises back, no finer: its targets
 * stand for their ancestors at `maximumTargetZoom`, the tile zoom of the
 * collapse.
 */
export const GroundReliefDemand = {
  tiles(input: GroundReliefDemandInput): Tile[] {
    const result: Tile[] = [];
    const seen = new Set<string>();
    const want = (tile: Tile) => {
      const key = tileKey(tile);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(tile);
    };

    // The camera's map: the tile under the point looked at, then the eight
    // around it, which the eye's ground falls in at a tilt.
    for (const tile of GroundReliefDemand.ring(input.centerWorldMercator, input.zooms.cameraZoom)) want(tile);

    // The targets' terrain, by the target's distance from the point looked at.
    const maximumTargetZoom = input.maximumTargetZoom ?? Number.MAX_SAFE_INTEGER;
    const distanceByTile = new Map<string, { tile: Tile; distance: number; order: number }>();
    const capped = new Set<string>();
    let order = 0;
    for (const deep of input.targets) {
      let target = deep;
      if (deep.tile.z > maximumTargetZoom) {
        const ancestor = tileParentAt(deep.tile, Math.max(maximumTargetZoom, 0));
        if (ancestor !== undefined) target = { tile: ancestor, worldWrap: deep.worldWrap };
      }
      const targetKey = `${tileKey(target.tile)}@${target.worldWrap}`;
      if (capped.has(targetKey)) continue;
      capped.add(targetKey);
      const sources = input.terrainSource(target.tile, target.tile.z);
      const count = 2 ** target.tile.z;
      const middleX = (target.tile.x + 0.5) / count + target.worldWrap;
      const middleY = (target.tile.y + 0.5) / count;
      const distance = Math.hypot(middleX - input.centerWorldMercator[0], middleY - input.centerWorldMercator[1]);
      for (const source of [sources.displacement, sources.terrain]) {
        const key = tileKey(source);
        const known = distanceByTile.get(key);
        if (known === undefined) distanceByTile.set(key, { tile: source, distance, order: order++ });
        else if (distance < known.distance) known.distance = distance;
      }
    }
    const byDistance = [...distanceByTile.values()].sort((a, b) => a.distance - b.distance || a.order - b.order);
    for (const entry of byDistance) want(entry.tile);

    // What the placements shown rise by: in, and kept.
    for (const placement of input.shown) {
      if (placement.displacement !== undefined) want(placement.displacement);
      if (placement.terrain !== undefined) want(placement.terrain);
    }
    // What the planner wanted and found out.
    for (const tile of input.also ?? []) want(tile);
    return result;
  },

  /**
   * The three by three tiles of `zoom` around a point: the point's own
   * first, then the four across its edges, then the four across its
   * corners. Fewer at the poles' rows and at the coarsest zooms, where the
   * tiles wrap onto each other.
   */
  ring(point: Vec2, zoom: number): Tile[] {
    const z = Math.max(0, zoom);
    const count = 2 ** z;
    const column = Math.min(Math.floor(wrapped(point[0]) * count), count - 1);
    const row = Math.min(Math.floor(Math.min(Math.max(point[1], 0), 1) * count), count - 1);
    const offsets: [number, number][] = [
      [0, 0],
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    const result: Tile[] = [];
    const seen = new Set<string>();
    for (const [dx, dy] of offsets) {
      const y = row + dy;
      if (y < 0 || y >= count) continue;
      const tile = { x: (((column + dx) % count) + count) % count, y, z };
      const key = tileKey(tile);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(tile);
    }
    return result;
  },
} as const;

function wrapped(x: number): number {
  const fraction = x - Math.floor(x);
  return fraction < 0 ? fraction + 1 : fraction;
}
