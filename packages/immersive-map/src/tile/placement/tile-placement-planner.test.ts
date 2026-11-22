// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TilePlacementPlannerTests`.

import { describe, expect, test } from "vitest";
import { inOwnSlot, makePlaceTile, type PlaceTile, type ResidentTile, type TileDrawRules, allDrawRules, type VisibleTile, visibleTileKey } from "./place-tile.ts";
import { buildPlacements } from "./tile-placement-planner.ts";
import { type Tile, tileKey } from "../tile.ts";

const parent: Tile = { x: 17, y: 11, z: 5 };
const children: Tile[] = [
  { x: 34, y: 22, z: 6 },
  { x: 35, y: 22, z: 6 },
  { x: 34, y: 23, z: 6 },
  { x: 35, y: 23, z: 6 },
];
const grandparent: Tile = { x: 8, y: 5, z: 4 };

const residentOf = (tiles: Tile[]) => new Map<string, ResidentTile>(tiles.map((tile) => [tileKey(tile), { tile }]));
const v = (tile: Tile, worldWrap = 0): VisibleTile => ({ tile, worldWrap });
const keys = (placed: PlaceTile<ResidentTile>[]) => new Set(placed.map((p) => tileKey(p.resident.tile)));
const set = (tiles: Tile[]) => new Set(tiles.map(tileKey));

function placements(targets: Tile[], resident: Map<string, ResidentTile>, backdropZoomLevel?: number) {
  return buildPlacements({ targets: targets.map((t) => v(t)), resident, backdropZoomLevel });
}

describe("buildPlacements", () => {
  test("a target waits for its terrain and the previous ground stands", () => {
    const resident = residentOf([parent, ...children]);
    const shownBefore = children.map((c) => makePlaceTile(resident.get(tileKey(c))!, v(c), { terrain: c }));
    let terrainIn = set(children);
    const plan = (previous: PlaceTile<ResidentTile>[]) =>
      buildPlacements({
        targets: [v(parent)],
        resident,
        previous,
        terrain: (tile) => ({ terrain: tile, displacement: tile }),
        terrainResident: (tile) => terrainIn.has(tileKey(tile)),
      });
    const waiting = plan(shownBefore);
    expect(keys(waiting)).toEqual(set(children));
    expect(waiting.every((p) => tileKey(p.terrain!) === tileKey(p.resident.tile) && tileKey(p.displacement!) === tileKey(p.resident.tile))).toBe(true);
    expect(keys(plan([]))).toEqual(set(children));
    terrainIn.add(tileKey(parent));
    const own = plan(shownBefore);
    expect(own.map((p) => tileKey(p.resident.tile))).toEqual([tileKey(parent)]);
    expect(own[0]!.terrain).toEqual(parent);
    terrainIn = set([parent]);
    expect(plan(shownBefore).map((p) => tileKey(p.resident.tile))).toEqual([tileKey(parent)]);
    terrainIn = new Set();
    expect(plan(shownBefore)).toEqual([]);
    expect(buildPlacements({ targets: [v(parent)], resident }).map((p) => p.terrain)).toEqual([undefined]);
  });

  test("a resident target draws itself", () => {
    const placed = placements([parent], residentOf([parent, grandparent]));
    expect(placed.length).toBe(1);
    expect(placed[0]!.resident.tile).toEqual(parent);
    expect(placed[0]!.placeIn.tile).toEqual(parent);
    expect(inOwnSlot(placed[0]!)).toBe(true);
  });

  test("a missing target draws its finest resident ancestor", () => {
    const placed = placements([parent], residentOf([grandparent, { x: 4, y: 2, z: 3 }]));
    expect(placed.length).toBe(1);
    expect(placed[0]!.resident.tile).toEqual(grandparent);
    expect(placed[0]!.placeIn.tile).toEqual(parent);
    expect(inOwnSlot(placed[0]!)).toBe(false);
  });

  test("an ancestor at the backdrop zoom is not a substitute", () => {
    const resident = residentOf([
      { x: 4, y: 2, z: 3 },
      { x: 2, y: 1, z: 2 },
    ]);
    expect(placements([parent], resident, 3)).toEqual([]);
    expect(placements([parent], resident)[0]!.resident.tile).toEqual({ x: 4, y: 2, z: 3 });
  });

  test("complete resident children stand in, and need no ancestor", () => {
    const placed = placements([parent], residentOf([...children, grandparent]));
    expect(keys(placed)).toEqual(set(children));
    expect(placed.every(inOwnSlot)).toBe(true);
  });

  test("partial children stay and the ancestor fills the holes", () => {
    const placed = placements([parent], residentOf([children[0]!, grandparent]));
    expect(keys(placed)).toEqual(set([children[0]!, grandparent]));
    const child = placed.find((p) => tileKey(p.resident.tile) === tileKey(children[0]!))!;
    const ancestor = placed.find((p) => tileKey(p.resident.tile) === tileKey(grandparent))!;
    expect(inOwnSlot(child)).toBe(true);
    expect(inOwnSlot(ancestor)).toBe(false);
    expect(ancestor.placeIn.tile).toEqual(parent);
  });

  test("partial children stand in when no ancestor is resident", () => {
    expect(keys(placements([parent], residentOf([children[0]!, children[3]!])))).toEqual(set([children[0]!, children[3]!]));
  });

  test("nested grandchildren complete a child, and descendants stand in at any depth", () => {
    const missing = children[3]!;
    const grandchildren: Tile[] = [];
    for (const dx of [0, 1]) for (const dy of [0, 1]) grandchildren.push({ x: missing.x * 2 + dx, y: missing.y * 2 + dy, z: 7 });
    expect(keys(placements([parent], residentOf([...children.slice(0, 3), ...grandchildren])))).toEqual(set([...children.slice(0, 3), ...grandchildren]));
    const deep: Tile = { x: parent.x << 11, y: parent.y << 11, z: 16 };
    const placed = placements([parent], residentOf([deep, grandparent]));
    expect(keys(placed)).toEqual(set([deep, grandparent]));
    expect(placed.find((p) => tileKey(p.resident.tile) === tileKey(deep))!.placeIn.tile).toEqual(deep);
  });

  test("nothing resident places nothing", () => {
    expect(placements([parent], new Map())).toEqual([]);
  });

  test("a stand-in inside two overlapping targets is placed once", () => {
    const child = children[0]!;
    const grandchild: Tile = { x: child.x * 2, y: child.y * 2, z: 7 };
    const placed = placements([child, parent], residentOf([grandchild]));
    expect(placed.length).toBe(1);
    expect(placed[0]!.resident.tile).toEqual(grandchild);
  });

  test("a wrapped target keeps its world wrap in every stand-in", () => {
    const wrapped = v(parent, 1);
    const placed = buildPlacements({ targets: [wrapped], resident: residentOf([grandparent, ...children]) });
    expect(keys(placed)).toEqual(set(children));
    expect(placed.every((p) => p.placeIn.worldWrap === 1)).toBe(true);
    const ancestor = buildPlacements({ targets: [wrapped], resident: residentOf([grandparent]) });
    expect(visibleTileKey(ancestor[0]!.placeIn)).toBe(visibleTileKey(wrapped));
    expect(inOwnSlot(ancestor[0]!)).toBe(false);
  });

  test("a resident target also stands in for its missing children", () => {
    const placed = placements([parent, children[0]!, children[1]!], residentOf([parent]));
    expect(placed.length).toBe(3);
    expect(placed.every((p) => tileKey(p.resident.tile) === tileKey(parent))).toBe(true);
    expect(new Set(placed.map((p) => tileKey(p.placeIn.tile)))).toEqual(set([parent, children[0]!, children[1]!]));
    expect(inOwnSlot(placed.find((p) => tileKey(p.placeIn.tile) === tileKey(parent))!)).toBe(true);
  });

  test("the backdrop context searches no descendants", () => {
    const placed = buildPlacements({ targets: [v({ x: 4, y: 2, z: 3 })], resident: residentOf([grandparent]), descendantSearchDepth: 0 });
    expect(placed).toEqual([]);
  });

  test("a stand-in that is a target draws as its own slot does", () => {
    const resident = residentOf([grandparent]);
    const near = v(parent);
    const far = v(grandparent);
    const farRules: TileDrawRules = { drawsLines: false, drawsLabels: false, raster: { size: 64 } };
    const slotRules = (slot: VisibleTile) => (visibleTileKey(slot) === visibleTileKey(far) ? farRules : allDrawRules);
    const placed = buildPlacements({ targets: [near, far], resident, slotRules });
    expect(placed.length).toBe(2);
    expect(placed.find((p) => visibleTileKey(p.placeIn) === visibleTileKey(near))!.rules).toEqual(farRules);
    expect(placed.find((p) => visibleTileKey(p.placeIn) === visibleTileKey(far))!.rules).toEqual(farRules);
    expect(buildPlacements({ targets: [near], resident, slotRules })[0]!.rules).toEqual(allDrawRules);
    const wrapped = v(grandparent, 1);
    const across = buildPlacements({ targets: [near, wrapped], resident, slotRules: (s) => (visibleTileKey(s) === visibleTileKey(wrapped) ? farRules : allDrawRules) });
    expect(across.find((p) => visibleTileKey(p.placeIn) === visibleTileKey(near))!.rules).toEqual(allDrawRules);
  });

  test("the output does not depend on any previous frame", () => {
    const resident = residentOf([grandparent]);
    expect(placements([parent], resident)).toEqual(placements([parent], resident));
    expect(placements([parent], new Map())).toEqual([]);
  });
});
