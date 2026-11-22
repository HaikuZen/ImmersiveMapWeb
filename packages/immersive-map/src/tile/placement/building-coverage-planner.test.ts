// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BuildingCoveragePlannerTests`: the tiles the ground
// shows, from the buildings' zoom on, draw their buildings in their own
// squares, however far from the camera the ground places them. Where a
// coarser one stands in over ground some of its children already show, the
// children draw and the coarser one draws the quarters they leave, when it
// keeps its buildings by quarters, and draws whole while they wait when it
// does not. Nothing coarser than the buildings' zoom draws.

import { describe, expect, test } from "vitest";
import { coverageSettings } from "../../configuration/tile-settings.ts";
import { quartersAll } from "../tile-quarters.ts";
import { type Tile, tileKey } from "../tile.ts";
import { BuildingCoveragePlanner, type BuildingSourceTile } from "./building-coverage-planner.ts";
import { inOwnSlot, makePlaceTile, type VisibleTile } from "./place-tile.ts";
import type { PlaceTilesContext } from "./place-tiles-context.ts";
import { buildPlacements } from "./tile-placement-planner.ts";

const cell: Tile = { x: 9908, y: 5140, z: 14 };
const children: Tile[] = [
  { x: 19816, y: 10280, z: 15 },
  { x: 19817, y: 10280, z: 15 },
  { x: 19816, y: 10281, z: 15 },
  { x: 19817, y: 10281, z: 15 },
];

/** The tiles in `quartered` keep their buildings by quarters, as a tile coarser than the tileset's deepest zoom does. */
function resident(tiles: readonly Tile[], quartered: readonly Tile[] = []): Map<string, BuildingSourceTile> {
  const byQuarters = new Set(quartered.map(tileKey));
  return new Map(tiles.map((tile) => [tileKey(tile), { tile, keepsBuildingsByQuarters: byQuarters.has(tileKey(tile)) }]));
}

const visible = (tiles: readonly Tile[], worldWrap = 0): VisibleTile[] => tiles.map((tile) => ({ tile, worldWrap }));

/** The buildings over the ground the planner shows for `targets`. */
function plan(residents: Map<string, BuildingSourceTile>, targets: VisibleTile[], minimumZoom = 15): PlaceTilesContext<BuildingSourceTile> {
  const ground = buildPlacements({ targets, resident: residents });
  return BuildingCoveragePlanner.plan(ground, true, minimumZoom);
}

const slots = (context: PlaceTilesContext<BuildingSourceTile>) => context.tilePlacements.map((p) => tileKey(p.placeIn.tile));
const keys = (tiles: readonly Tile[]) => tiles.map(tileKey);
const quarters = (tile: Tile, context: PlaceTilesContext<BuildingSourceTile>) => context.tilePlacements.find((p) => tileKey(p.placeIn.tile) === tileKey(tile))?.quarters;

describe("BuildingCoveragePlanner", () => {
  test("the resident targets draw in their own places", () => {
    const context = plan(resident(children), visible(children));
    expect(new Set(slots(context))).toEqual(new Set(keys(children)));
    expect(context.tilePlacements.every(inOwnSlot)).toBe(true);
  });

  test("the finer tiles draw and the coarser tile draws the quarters they leave", () => {
    const context = plan(resident([cell, ...children.slice(0, 2)], [cell]), visible(children), 14);
    expect(new Set(slots(context))).toEqual(new Set(keys([cell, ...children.slice(0, 2)])));
    expect(quarters(cell, context), "the south-west and the south-east").toBe(0b1100);
    for (const child of children.slice(0, 2)) expect(quarters(child, context), "whole").toBe(quartersAll);
    expect(context.tilePlacements.every(inOwnSlot), "in its own square").toBe(true);
  });

  test("a coarser tile whose children are all in draws nothing", () => {
    const ground = buildPlacements({ targets: visible(children), resident: resident(children) });
    const cellPlacement = makePlaceTile(resident([cell], [cell]).get(tileKey(cell))!, { tile: cell, worldWrap: 0 });
    const context = BuildingCoveragePlanner.plan([...ground, cellPlacement], true, 14);
    expect(new Set(slots(context))).toEqual(new Set(keys(children)));
  });

  test("a coarser tile kept whole draws and its children wait", () => {
    const context = plan(resident([cell, ...children.slice(0, 2)]), visible(children), 14);
    expect(slots(context)).toEqual(keys([cell]));
    expect(quarters(cell, context)).toBe(quartersAll);
  });

  test("a coarser tile standing in alone draws", () => {
    const context = plan(resident([cell], [cell]), visible(children), 14);
    expect(slots(context)).toEqual(keys([cell]));
    expect(quarters(cell, context)).toBe(quartersAll);
  });

  test("a tile under a drawn quarter waits", () => {
    const grandchild: Tile = { x: 39632, y: 20560, z: 16 };
    const residents = resident([cell, grandchild], [cell]);
    const ground = [cell, grandchild].map((tile) => makePlaceTile(residents.get(tileKey(tile))!, { tile, worldWrap: 0 }));
    const context = BuildingCoveragePlanner.plan(ground, true, 14);
    expect(slots(context)).toEqual(keys([cell]));
    expect(quarters(cell, context)).toBe(quartersAll);
  });

  test("a stand-in coarser than the buildings' zoom draws none", () => {
    const context = plan(resident([cell, ...children.slice(0, 2)]), visible(children));
    expect(new Set(slots(context))).toEqual(new Set(keys(children.slice(0, 2))));
  });

  test("a frame below the buildings' zoom plans none", () => {
    const residents = resident([cell, ...children]);
    expect(plan(residents, visible([cell])).tilePlacements, "a z14 frame under buildings from 15").toEqual([]);
    expect(slots(plan(residents, visible([cell]), 14)), "buildings from 14: the z14 frame draws them").toEqual(keys([cell]));
    const coarse: VisibleTile[] = [{ tile: { x: cell.x / 2, y: cell.y / 2, z: 13 }, worldWrap: 0 }];
    expect(
      slots(plan(residents, coarse, 0)),
      "coarser than the tiles that carry buildings, never: the z13 frame's ground is the z14 cell standing in, and it draws",
    ).toEqual(keys([cell]));
  });

  test("a far tile the ground places draws its buildings", () => {
    const far: Tile = { x: (cell.x + 5) * 2, y: cell.y * 2, z: 15 };
    const context = plan(resident([...children, far]), visible([...children, far]));
    expect(new Set(slots(context))).toEqual(new Set(keys([...children, far])));
  });

  test("wrapped copies stay apart", () => {
    const context = plan(resident(children), [...visible(children, 0), ...visible(children, 1)]);
    expect(context.tilePlacements.length).toBe(8);
    expect(new Set(context.tilePlacements.map((p) => p.placeIn.worldWrap))).toEqual(new Set([0, 1]));
  });

  test("the globe has no building coverage", () => {
    const ground = buildPlacements({ targets: visible(children), resident: resident(children) });
    expect(BuildingCoveragePlanner.plan(ground, false).tilePlacements).toEqual([]);
  });

  test("the output order is deterministic", () => {
    const context = plan(resident(children), visible([...children].reverse()));
    expect(slots(context)).toEqual(keys([...children].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y))));
  });

  test("the draw zoom follows the setting", () => {
    const drawZoom = (minimumZoom: number, maximumTileZoom = 15) =>
      BuildingCoveragePlanner.minimumDrawZoom({
        scene: { extrusion: { buildingsMinimumZoom: minimumZoom } },
        tiles: { coverage: coverageSettings({ maximumZoomLevel: maximumTileZoom }) },
      });
    expect(drawZoom(15)).toBe(15);
    expect(drawZoom(15.5)).toBe(15);
    expect(drawZoom(17), "the tiles stop at 15: a camera at 17 targets them").toBe(15);
    expect(drawZoom(12), "coarser tiles carry merged blocks, never drawn").toBe(14);
    expect(drawZoom(16, 18)).toBe(16);
  });
});
