// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { mat4TransformVec4 } from "../../math/matrix.ts";
import type { VisibleTile } from "../../tile/placement/place-tile.ts";
import { modelTilePlacement, wantedModelTiles } from "./model-tile-placement.ts";

/** Swift `ModelTileWantedTilesTests`: the model tiles over the map tiles a frame draws, and the ring around them, nearest first. */
const visible = (x: number, y: number, z: number, worldWrap = 0): VisibleTile => ({ tile: { x, y, z }, worldWrap });
const wanted = (x: number, y: number, worldWrap = 0): VisibleTile => visible(x, y, 14, worldWrap);
const keys = (tiles: readonly VisibleTile[]) => tiles.map((t) => `${t.tile.z}/${t.tile.x}/${t.tile.y}@${t.worldWrap}`);

describe("wantedModelTiles", () => {
  it("wants a map tile of the same zoom and its ring", () => {
    const tiles = wantedModelTiles([visible(9904, 5121, 14)]);
    expect(tiles[0]).toEqual(wanted(9904, 5121));
    expect(tiles.length).toBe(9);
    expect(new Set(keys(tiles)).size).toBe(9);
    expect(keys(tiles)).toContain("14/9903/5120@0");
    expect(keys(tiles)).toContain("14/9905/5122@0");
  });

  it("wants the model tile over deeper map tiles once", () => {
    const tiles = wantedModelTiles([visible(39616, 20484, 16), visible(39617, 20484, 16), visible(39616, 20485, 16), visible(39619, 20487, 16)]);
    expect(tiles[0]).toEqual(wanted(9904, 5121));
    expect(tiles.length).toBe(9);
  });

  it("wants nothing for coarser map tiles", () => {
    expect(wantedModelTiles([visible(4952, 2560, 13), visible(0, 0, 2)])).toEqual([]);
  });

  it("puts the tiles in view before their ring", () => {
    const tiles = wantedModelTiles([visible(9904, 5121, 14), visible(9910, 5121, 14)]);
    expect(tiles.slice(0, 2)).toEqual([wanted(9904, 5121), wanted(9910, 5121)]);
    expect(tiles.length).toBe(18);
  });

  it("crosses the seam into the next copy and stops at the edge", () => {
    const tiles = wantedModelTiles([visible(0, 0, 14)]);
    // No row above the top one.
    expect(tiles.length).toBe(6);
    expect(keys(tiles)).toContain("14/16383/0@-1");
    expect(keys(tiles)).toContain("14/16383/1@-1");
    expect(keys(tiles)).toContain("14/1/1@0");
    expect(tiles.every((t) => t.tile.y >= 0)).toBe(true);
  });

  it("keeps the copy of the world a tile is seen in", () => {
    const tiles = wantedModelTiles([visible(9904, 5121, 14, 0), visible(9904, 5121, 14, 1)]);
    expect(tiles.slice(0, 2)).toEqual([wanted(9904, 5121), wanted(9904, 5121, 1)]);
    expect(tiles.length).toBe(18);
  });
});

describe("modelTilePlacement", () => {
  it("places a model tile where the map tile is", () => {
    const flat = { pan: [0.1, -0.2] as const, renderMapSize: 4096 };
    const tile = { x: 9904, y: 5121, z: 14 };
    const [ex, ey, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, 1, flat.pan, flat.renderMapSize);
    const placement = modelTilePlacement(tile, 1, flat);
    expect(placement.origin).toEqual([ex, ey, 0]);
    expect(placement.scale).toBe(size / 4096);
    const far = mat4TransformVec4(placement.modelMatrix, [4096, 4096, 0, 1]);
    expect(far[0]).toBeCloseTo(ex + size, 9);
    expect(far[1]).toBeCloseTo(ey + size, 9);
    // Heights take the same scale.
    expect(mat4TransformVec4(placement.modelMatrix, [0, 0, 4096, 1])[2]).toBeCloseTo(size, 9);
  });
});
