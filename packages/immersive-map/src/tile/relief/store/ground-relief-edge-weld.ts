// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Tile } from "../../tile.ts";
import { floatToHalfBits, halfBitsToFloat } from "./half-float.ts";
import type { GroundReliefTile } from "./ground-relief-tile.ts";

/** One write into a tile's texels: a rectangle of `width` by `height` from the column `x` and the row `y`, row by row. */
export interface GroundReliefEdgeWeldWrite {
  readonly terrain: GroundReliefTile;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly values: Uint16Array<ArrayBuffer>;
}

/**
 * Welds a terrain tile's edges to its neighbours' of the same zoom, a port
 * of the Swift `GroundReliefEdgeWeld`.
 *
 * A terrain tile's pixel is a cell, its height the cell's middle's
 * (Terrarium, Mapbox Terrain-RGB): no pixel lies on the tile's edge, whose
 * height is between the tile's last pixel and its neighbour's first. The
 * ground over a tile reads its edge as the last pixel (the sampler clamps
 * at it), the ground over the neighbour as the first one, and the two meet
 * with a step as tall as the slope over one pixel: a crack tens of metres
 * high on a mountain at the coarse zooms. Welded, both edges hold the mean
 * of the two pixels, the height on the edge itself, and the ground closes.
 *
 * Each edge but its two end texels is welded with the neighbour across it.
 * Each corner texel, where four tiles meet, takes the mean of the corners
 * of the tiles that are in, so every one of them holds the same. A tile
 * with no neighbour in keeps its edge as decoded, and is welded when the
 * neighbour arrives. The means are of the decoded edges
 * (`GroundReliefTile.originalEdges`), so the weld is the same in any order
 * of arrival. Tiles of another size are left apart.
 */
export const GroundReliefEdgeWeld = {
  /**
   * The writes that weld `terrain`, just arrived at `tile`, to the
   * neighbours `neighbour` finds in (the tile itself among them): its four
   * edges and its four corners, and the neighbours' sides of them.
   */
  writes(tile: Tile, terrain: GroundReliefTile, neighbour: (tile: Tile) => GroundReliefTile | undefined): GroundReliefEdgeWeldWrite[] {
    const size = terrain.size;
    if (size < 2) return [];
    const count = 2 ** tile.z;
    const find = (x: number, y: number): GroundReliefTile | undefined => {
      if (y < 0 || y >= count) return undefined;
      const wrapped = ((x % count) + count) % count;
      const isSelf = wrapped === tile.x && y === tile.y;
      const found = isSelf ? terrain : neighbour({ x: wrapped, y, z: tile.z });
      return found !== undefined && found.size === size ? found : undefined;
    };
    const writes: GroundReliefEdgeWeldWrite[] = [];
    const inner = size - 2;

    // The edges: the tile's side and the neighbour's, without the end
    // texels, which are the corners'.
    if (inner > 0) {
      const east = find(tile.x + 1, tile.y);
      if (east !== undefined && east !== terrain) {
        const mean = means(terrain.originalEdges.east, east.originalEdges.west);
        writes.push({ terrain, x: size - 1, y: 1, width: 1, height: inner, values: mean });
        writes.push({ terrain: east, x: 0, y: 1, width: 1, height: inner, values: mean });
      }
      const west = find(tile.x - 1, tile.y);
      if (west !== undefined && west !== terrain) {
        const mean = means(terrain.originalEdges.west, west.originalEdges.east);
        writes.push({ terrain, x: 0, y: 1, width: 1, height: inner, values: mean });
        writes.push({ terrain: west, x: size - 1, y: 1, width: 1, height: inner, values: mean });
      }
      const north = find(tile.x, tile.y - 1);
      if (north !== undefined) {
        const mean = means(terrain.originalEdges.north, north.originalEdges.south);
        writes.push({ terrain, x: 1, y: 0, width: inner, height: 1, values: mean });
        writes.push({ terrain: north, x: 1, y: size - 1, width: inner, height: 1, values: mean });
      }
      const south = find(tile.x, tile.y + 1);
      if (south !== undefined) {
        const mean = means(terrain.originalEdges.south, south.originalEdges.north);
        writes.push({ terrain, x: 1, y: size - 1, width: inner, height: 1, values: mean });
        writes.push({ terrain: south, x: 1, y: 0, width: inner, height: 1, values: mean });
      }
    }

    // The corners, by the point of the tile grid each lies on: the four
    // tiles around the point, each by its corner there.
    const last = size - 1;
    const points: [number, number][] = [
      [tile.x, tile.y],
      [tile.x + 1, tile.y],
      [tile.x, tile.y + 1],
      [tile.x + 1, tile.y + 1],
    ];
    // North-west of the point, its south-east corner; north-east, its
    // south-west; south-west, its north-east; south-east, its north-west.
    const around: [number, number, number, number][] = [
      [-1, -1, last, last],
      [0, -1, 0, last],
      [-1, 0, last, 0],
      [0, 0, 0, 0],
    ];
    for (const [pointX, pointY] of points) {
      const corners: { terrain: GroundReliefTile; x: number; y: number }[] = [];
      for (const [dx, dy, cornerX, cornerY] of around) {
        // At the lowest zooms a tile is its own neighbour across the
        // antimeridian: its corner counts once.
        const found = find(pointX + dx, pointY + dy);
        if (found === undefined || corners.some((corner) => corner.terrain === found)) continue;
        corners.push({ terrain: found, x: cornerX, y: cornerY });
      }
      if (corners.length <= 1) continue;
      let total = 0;
      for (const corner of corners) total += halfBitsToFloat(corner.terrain.originalCorner(corner.x, corner.y));
      const value = new Uint16Array([floatToHalfBits(Math.fround(total / corners.length))]);
      for (const corner of corners) writes.push({ terrain: corner.terrain, x: corner.x, y: corner.y, width: 1, height: 1, values: value });
    }
    return writes;
  },
} as const;

/** The means of two edges texel by texel, without their end texels, as half floats. */
function means(first: Uint16Array, second: Uint16Array): Uint16Array<ArrayBuffer> {
  const result = new Uint16Array(first.length - 2);
  for (let index = 1; index < first.length - 1; index++) {
    result[index - 1] = floatToHalfBits(Math.fround((halfBitsToFloat(first[index]!) + halfBitsToFloat(second[index]!)) / 2));
  }
  return result;
}
