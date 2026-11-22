// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the demand's and the terrain zooms' part of the Swift
// `GroundReliefTests`: what a frame asks the store for, in which order, and
// which terrain each ring reads.

import { describe, expect, test } from "vitest";
import { makePlaceTile, type VisibleTile } from "../../placement/place-tile.ts";
import { type Tile, tileKey, tileParentAt } from "../../tile.ts";
import { flatRingBand, flatRingRule, FlatRingRules } from "../../visibility/flat-ring-rules.ts";
import { GroundReliefDemand } from "./ground-relief-demand.ts";
import { GroundReliefTerrainZooms } from "./ground-relief-terrain-zooms.ts";

const visible = (tile: Tile): VisibleTile => ({ tile, worldWrap: 0 });
const keys = (tiles: readonly Tile[]) => tiles.map(tileKey);
// A point in the north-east quarter of its zoom 10 tile.
const point: [number, number] = [(300 + 0.8) / 1024, (400 + 0.3) / 1024];

describe("GroundReliefDemand", () => {
  test("the demand is capped at the collapse zoom and asks what the planner wanted", () => {
    const zooms = new GroundReliefTerrainZooms(10, 10, [flatRingBand(17, 1, 9, 17)]);
    const streets = [0, 1, 2, 3].map((index) => visible({ x: 38500 + (index % 2), y: 51240 + Math.floor(index / 2), z: 17 }));
    const wanted: Tile = { x: 2406, y: 3202, z: 13 };
    const tiles = GroundReliefDemand.tiles({
      targets: streets,
      shown: [],
      also: [wanted],
      centerWorldMercator: point,
      zooms,
      maximumTargetZoom: 13,
      terrainSource: (tile) => ({ terrain: tile, displacement: tile }),
    });
    expect(tiles.some((tile) => tile.z === 17), "no street tile's own terrain").toBe(false);
    expect(new Set(keys(tiles.filter((tile) => tile.z === 13))), "the four street tiles' one zoom 13 ancestor, and what the planner wanted").toEqual(
      new Set(keys([tileParentAt(streets[0]!.tile, 13)!, wanted])),
    );
    expect(tiles.at(-1), "what the planner wanted, last").toEqual(wanted);
  });

  test("what the planner wanted comes after everything the frame reads", () => {
    const zooms = new GroundReliefTerrainZooms(10);
    const near = visible({ x: 2406, y: 3202, z: 13 });
    const wanted: Tile = { x: 1, y: 1, z: 4 };
    const tiles = GroundReliefDemand.tiles({ targets: [near], shown: [], also: [wanted], centerWorldMercator: point, zooms, terrainSource: (tile) => ({ terrain: tile, displacement: tile }) });
    expect(tiles.length).toBe(9 + 1 + 1);
    expect(tiles.at(-1)).toEqual(wanted);
  });

  test("the demand asks for the camera's map, then the targets, then the shown", () => {
    const zooms = new GroundReliefTerrainZooms(10, 10, [flatRingBand(13, 1, 9, 13), flatRingBand(12, 3, 9, 10)]);
    const near = visible({ x: 2406, y: 3202, z: 13 });
    const far = visible({ x: 1300, y: 1700, z: 12 });
    const shownTerrain: Tile = { x: 2405, y: 3202, z: 13 };
    const shown = makePlaceTile({ tile: shownTerrain }, visible(shownTerrain), { terrain: shownTerrain });
    const tiles = GroundReliefDemand.tiles({
      targets: [far, near],
      shown: [shown],
      centerWorldMercator: point,
      zooms,
      terrainSource: (tile, targetZoom) => ({ terrain: zooms.terrainTile(tile, targetZoom), displacement: zooms.displacementTile(tile, targetZoom) }),
    });
    expect(tiles.length).toBe(9 + 2 + 1);
    expect(tiles[0], "the tile under the point first").toEqual({ x: 300, y: 400, z: 10 });
    expect(tiles.slice(0, 9).every((tile) => tile.z === 10)).toBe(true);
    expect(tiles[9], "the near target's own terrain before the far target's, its zoom 10 map the camera's").toEqual(near.tile);
    expect(tiles[10], "the far target's ring reads zoom 10").toEqual(tileParentAt(far.tile, 10));
    expect(tiles[11], "what the placement shown rises by, last").toEqual(shownTerrain);
    expect(GroundReliefDemand.ring([0.5, 0.5], 0)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  test("the camera's ring is the point's tile, then across its edges, then its corners, wrapped and clipped at the poles", () => {
    const ring = GroundReliefDemand.ring([0.001, 0.001], 2);
    expect(ring[0]).toEqual({ x: 0, y: 0, z: 2 });
    expect(keys(ring)).toEqual(keys([
      { x: 0, y: 0, z: 2 },
      { x: 3, y: 0, z: 2 },
      { x: 1, y: 0, z: 2 },
      { x: 0, y: 1, z: 2 },
      { x: 3, y: 1, z: 2 },
      { x: 1, y: 1, z: 2 },
    ]));
    expect(GroundReliefDemand.ring([0.5, 0.5], 1).length, "four tiles at zoom 1, each once").toBe(4);
  });
});

describe("GroundReliefTerrainZooms", () => {
  test("the default rules read the near ring's own terrain", () => {
    expect(FlatRingRules.default.rules.map((rule) => rule.terrainZoomDrop)).toEqual([0, 2, 1, 3]);
    expect(
      FlatRingRules.default.rules.map((rule) => rule.zoomDrop + rule.terrainZoomDrop),
      "under the near tiles' zoom",
    ).toEqual([0, 3, 3, 7]);
    const wild: FlatRingRules = { rules: [flatRingRule(0, 1, { terrainZoomDrop: 99 }), flatRingRule(1, 2, { terrainZoomDrop: -4 })] };
    expect(FlatRingRules.normalized(wild).rules.map((rule) => rule.terrainZoomDrop)).toEqual([8, 0]);
    expect(flatRingRule(2, 3).terrainZoomDrop, "own terrain unless said otherwise").toBe(0);
  });

  test("each ring reads the terrain its band gives it", () => {
    const bands = [flatRingBand(13, 1, 9, 13), flatRingBand(12, 2, 7, 10), flatRingBand(12, 3, 7, 8), flatRingBand(9, 9, 20, 6)];
    const zooms = new GroundReliefTerrainZooms(10, 10, bands);
    expect(zooms.cameraZoom).toBe(10);
    const range = [9, 10, 11, 12, 13, 14];
    expect(range.map((zoom) => zooms.terrainZoom(zoom))).toEqual([6, 10, 11, 10, 13, 14]);
    expect(range.map((zoom) => zooms.displacementZoom(zoom)), "the grid rises by terrain no finer than zoom 10").toEqual([6, 10, 10, 10, 10, 10]);
    const near: Tile = { x: 4823, y: 6160, z: 13 };
    expect(zooms.displacementTile(near, 13)).toEqual(tileParentAt(near, 10));
    expect(zooms.terrainTile(near, 13), "shaded by its own").toEqual(near);
    expect(new GroundReliefTerrainZooms(10, 13, bands).displacementTile(near, 13), "raised, the grid rises by its own").toEqual(near);
    expect(zooms.statusText).toBe("z13→z13 z12→z10 z9→z6");
    const deep: Tile = { x: 9647, y: 12321, z: 15 };
    expect(zooms.terrainTile(deep, 12)).toEqual(tileParentAt(deep, 10));
    expect(zooms.terrainTile(deep, 13)).toEqual(tileParentAt(deep, 13));
    const coarse: Tile = { x: 37, y: 48, z: 7 };
    expect(zooms.terrainTile(coarse, 13), "a stand-in coarser than the ring's terrain reads its own address").toEqual(coarse);
    expect(flatRingBand(11, 2, 1).terrainZoom, "left out is the band's own").toBe(11);
    expect(new GroundReliefTerrainZooms(12).terrainZoom(15), "no bands: a ground outside a frame reads each tile's own terrain").toBe(15);
  });

  test("two zooms of terrain are equal by their values", () => {
    const bands = [flatRingBand(13, 1, 9, 13)];
    expect(new GroundReliefTerrainZooms(10, 10, bands).equals(new GroundReliefTerrainZooms(10, 10, bands))).toBe(true);
    expect(new GroundReliefTerrainZooms(10, 10, bands).equals(new GroundReliefTerrainZooms(10, 10, [flatRingBand(13, 1, 9, 12)]))).toBe(false);
    expect(new GroundReliefTerrainZooms(10, 10, bands).equals(new GroundReliefTerrainZooms(11, 10, bands))).toBe(false);
  });
});
