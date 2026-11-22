// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `FlatTileCoverageTests`: the flat map's tile
// enumeration, the tiles of one zoom under a polygon, which the bands and the
// horizon backdrop are built from.

import { describe, expect, test } from "vitest";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import { type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import { tileCovers } from "../tile.ts";
import { CoveragePolygon } from "./coverage-polygon.ts";
import { FlatTileCoverage } from "./flat-tile-coverage.ts";

/** A z9 world whose tiles are one world unit wide, so distances read in tiles. */
const zoom = 9;
const flatRenderState: FlatRenderState = { pan: [0, 0], renderMapSize: 2 ** zoom };
const lookAt: Vec2 = [256.5, 250.5];

/** The world position of a point in tile units (tile y grows south, world y north). */
function world(point: Vec2): Vec2 {
  const x = Math.floor(point[0]);
  const y = Math.floor(point[1]);
  const origin = ImmersiveMapProjection.flatTileOriginAndSize(x, y, zoom, 0, flatRenderState.pan, flatRenderState.renderMapSize);
  const size = origin[2];
  return [origin[0] + (point[0] - x) * size, origin[1] + (1 - (point[1] - y)) * size];
}

/**
 * The ground a square 45 degree frustum sees from a camera 1.2 tiles from the
 * look-at point at `tilt` degrees, as the convex wedge the enumeration tests
 * tiles against.
 */
function polygon(tilt: number, reach = 40): CoveragePolygon {
  const distance = 1.2;
  const forward: Vec2 = [0, -1];
  const right: Vec2 = [1, 0];
  const eyeGround: Vec2 = [lookAt[0] - forward[0] * distance * Math.sin((tilt * Math.PI) / 180), lookAt[1] - forward[1] * distance * Math.sin((tilt * Math.PI) / 180)];
  const halfWidth = (ahead: number) => ahead * Math.tan(Math.PI / 8) + 0.5;
  const near = 0.25;
  const nearCenter: Vec2 = [eyeGround[0] + forward[0] * near, eyeGround[1] + forward[1] * near];
  const farCenter: Vec2 = [eyeGround[0] + forward[0] * reach, eyeGround[1] + forward[1] * reach];
  const nearSide = right[0] * halfWidth(near);
  const farSide = right[0] * halfWidth(reach);
  const corners: Vec2[] = [
    [nearCenter[0] - nearSide, nearCenter[1]],
    [nearCenter[0] + nearSide, nearCenter[1]],
    [farCenter[0] + farSide, farCenter[1]],
    [farCenter[0] - farSide, farCenter[1]],
  ];
  return new CoveragePolygon(corners.map(world));
}

/** The leaves the polygon meets, column by column. */
function leaves(shape: CoveragePolygon): VisibleTile[] {
  const tileSize = flatRenderState.renderMapSize / 2 ** zoom;
  const half = flatRenderState.renderMapSize / 2;
  const minColumn = Math.floor((shape.bounds.minX + half) / tileSize) - 1;
  const maxColumn = Math.floor((shape.bounds.maxX + half) / tileSize) + 1;
  const minRow = Math.floor((half - shape.bounds.maxY) / tileSize) - 1;
  const maxRow = Math.floor((half - shape.bounds.minY) / tileSize) + 1;
  const tiles: VisibleTile[] = [];
  for (let y = minRow; y <= maxRow; y++) {
    for (let x = minColumn; x <= maxColumn; x++) {
      const origin = ImmersiveMapProjection.flatTileOriginAndSize(x, y, zoom, 0, flatRenderState.pan, flatRenderState.renderMapSize);
      if (shape.intersects(origin[0], origin[1], origin[0] + origin[2], origin[1] + origin[2])) tiles.push({ tile: { x, y, z: zoom }, worldWrap: 0 });
    }
  }
  return tiles;
}

function cover(tile: VisibleTile, output: readonly VisibleTile[]): VisibleTile | undefined {
  return output.find(
    (candidate) =>
      candidate.worldWrap === tile.worldWrap &&
      ((candidate.tile.x === tile.tile.x && candidate.tile.y === tile.tile.y && candidate.tile.z === tile.tile.z) || tileCovers(candidate.tile, tile.tile)),
  );
}

const keySet = (tiles: readonly VisibleTile[]) => new Set(tiles.map(visibleTileKey));

describe("FlatTileCoverage", () => {
  test("the enumeration at a zoom is the tiles the polygon meets", () => {
    const shape = polygon(75);
    const tiles = FlatTileCoverage.tiles(zoom, shape, flatRenderState);
    expect(keySet(tiles)).toEqual(keySet(leaves(shape)));
    expect(keySet(tiles).size).toBe(tiles.length);
    expect(FlatTileCoverage.tiles(zoom, shape, flatRenderState), "deterministic").toEqual(tiles);
  });

  test("the backdrop enumerates the footprint at its zoom", () => {
    const shape = polygon(75);
    const visited = { count: 0 };
    const backdrop = FlatTileCoverage.tiles(3, shape, flatRenderState, visited);
    expect(backdrop.length).toBeGreaterThan(0);
    expect(visited.count).toBeGreaterThan(backdrop.length);
    expect(backdrop.every((tile) => tile.tile.z === 3)).toBe(true);
    for (const leaf of leaves(shape)) expect(cover(leaf, backdrop), `${visibleTileKey(leaf)} is under a backdrop tile`).toBeDefined();
    expect(FlatTileCoverage.tiles(3, shape, flatRenderState), "deterministic").toEqual(backdrop);
  });

  test("the sort is finest first", () => {
    const v = (x: number, y: number, z: number, worldWrap = 0): VisibleTile => ({ tile: { x, y, z }, worldWrap });
    const sorted = FlatTileCoverage.sorted([v(1, 1, 3), v(0, 0, 5, 1), v(0, 0, 5), v(2, 0, 3)]);
    expect(sorted).toEqual([v(0, 0, 5), v(0, 0, 5, 1), v(1, 1, 3), v(2, 0, 3)]);
  });
});
