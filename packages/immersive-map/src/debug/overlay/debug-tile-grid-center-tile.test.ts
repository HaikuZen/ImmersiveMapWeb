// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugTileGridCenterTileTests`: which placement the
// debug grid draws on.

import { describe, expect, test } from "vitest";
import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import { makePlaceTile, type PlaceTile, type ResidentTile } from "../../tile/placement/place-tile.ts";
import { DebugTileGridCenterTile } from "./debug-tile-grid-center-tile.ts";

function makePlaceTiles(coordinates: readonly { x: number; y: number; worldWrap: number }[], zoom: number): PlaceTile<ResidentTile>[] {
  return coordinates.map(({ x, y, worldWrap }) => {
    const tile = { x, y, z: zoom };
    return makePlaceTile({ tile }, { tile, worldWrap });
  });
}

function screenPoint(x: number, y: number, visible: number): ScreenPointOutput {
  return { positionX: x, positionY: y, depth: 0, visible, visibilityAlpha: visible };
}

describe("DebugTileGridCenterTile", () => {
  test("no placements yield no candidate", () => {
    expect(DebugTileGridCenterTile.candidates([], [0.5, 0.5])).toEqual([]);
  });

  test("exactly one tile of a cover contains the centre", () => {
    // Zoom two, so the world is a four by four grid: the centre sits inside
    // tile (2, 1) at world (0.6, 0.4).
    const coordinates = [];
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) coordinates.push({ x: column, y: row, worldWrap: 0 });
    const candidates = DebugTileGridCenterTile.candidates(makePlaceTiles(coordinates, 2), [0.6, 0.4]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.placeIn.tile).toEqual({ x: 2, y: 1, z: 2 });
  });

  // A centre landing exactly on a shared edge belongs to the tile the edge
  // starts, never to both, or the grid would flicker between two tiles while
  // panning.
  test("a centre on a tile edge belongs to one tile only", () => {
    const placeTiles = makePlaceTiles(
      [
        { x: 0, y: 0, worldWrap: 0 },
        { x: 1, y: 0, worldWrap: 0 },
        { x: 0, y: 1, worldWrap: 0 },
        { x: 1, y: 1, worldWrap: 0 },
      ],
      1,
    );
    const candidates = DebugTileGridCenterTile.candidates(placeTiles, [0.5, 0.5]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.placeIn.tile).toEqual({ x: 1, y: 1, z: 1 });
  });

  test("wrapped world copies all contain the centre", () => {
    const placeTiles = makePlaceTiles(
      [
        { x: 1, y: 0, worldWrap: -1 },
        { x: 1, y: 0, worldWrap: 0 },
        { x: 1, y: 0, worldWrap: 1 },
        { x: 0, y: 0, worldWrap: 0 },
      ],
      1,
    );
    const candidates = DebugTileGridCenterTile.candidates(placeTiles, [0.75, 0.25]);
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((candidate) => candidate.placeIn.worldWrap))).toEqual(new Set([-1, 0, 1]));
  });

  test("the copy under the middle of the view wins", () => {
    const candidates = makePlaceTiles(
      [
        { x: 1, y: 0, worldWrap: -1 },
        { x: 1, y: 0, worldWrap: 0 },
        { x: 1, y: 0, worldWrap: 1 },
      ],
      1,
    );
    const projected = [screenPoint(-900, 400, 1), screenPoint(520, 380, 1), screenPoint(1900, 400, 1)];
    expect(DebugTileGridCenterTile.nearestToViewportCenter(candidates, projected, [1000, 800])?.placeIn.worldWrap).toBe(0);
  });

  test("copies that do not project are ignored", () => {
    const candidates = makePlaceTiles(
      [
        { x: 1, y: 0, worldWrap: 0 },
        { x: 1, y: 0, worldWrap: 1 },
      ],
      1,
    );
    // Closest to the middle, but behind the camera, so it is not on screen.
    const projected = [screenPoint(500, 400, 0), screenPoint(900, 400, 1)];
    expect(DebugTileGridCenterTile.nearestToViewportCenter(candidates, projected, [1000, 800])?.placeIn.worldWrap).toBe(1);
  });
});
