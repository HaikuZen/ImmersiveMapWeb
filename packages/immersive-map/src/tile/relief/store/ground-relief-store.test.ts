// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the store's part of the Swift `GroundReliefTests`: the frame's
// demand and the loads, the fall back to an ancestor where the source has no
// terrain, the floor, the source out of reach, the terrain's lifetime and the
// released cache, the edges' weld and the status. The Swift textures are
// plain objects here (`FakeReliefTextures`), and the URL source's fetches are
// loads the test answers by hand (`FakeTerrainSource`). The decoding is
// crates/ground-relief's, the occlusion's bytes are
// crates/bench-wasm/src/occlusion.rs's and the GPU module's.

import { afterEach, describe, expect, test } from "vitest";
import { groundReliefSettings } from "../../../configuration/tile-settings.ts";
import { defaultTerrainOcclusion } from "../../../style/theme.ts";
import { type Tile, tileKey, tileParentAt } from "../../tile.ts";
import { flatRingBand } from "../../visibility/flat-ring-rules.ts";
import { GroundReliefTileLift } from "../lifts/ground-relief-tile-lift.ts";
import { GroundReliefUniform } from "../frame/ground-relief-uniform.ts";
import { type FakeAnswer, FakeClock, FakeReliefTextures, flatAnswer, loadUntil, makeTestRelief, type TestRelief } from "../testing/ground-relief-fakes.ts";
import { GroundReliefLoadStates } from "./ground-relief-load-states.ts";
import { halfBitsToFloat } from "./half-float.ts";

function expectClose(actual: number | undefined, expected: number, accuracy: number, message?: string): void {
  expect(actual, message).toBeDefined();
  expect(Math.abs(actual! - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

const made: TestRelief[] = [];
function relief(settings: Parameters<typeof groundReliefSettings>[0], answer: (tile: Tile) => FakeAnswer, clock?: FakeClock): TestRelief {
  const value = makeTestRelief(groundReliefSettings({ isEnabled: true, ...settings }), answer, clock === undefined ? {} : { clock });
  made.push(value);
  return value;
}
afterEach(() => {
  for (const value of made.splice(0)) value.store.destroy();
});

const parentOf = (tile: Tile, zoom: number): Tile => tileParentAt(tile, zoom)!;
const sameTile = (a: Tile | undefined, b: Tile) => a !== undefined && tileKey(a) === tileKey(b);

describe("GroundReliefStore, the loads", () => {
  test("the wanted tiles on their way are counted", async () => {
    const present: Tile = { x: 4823, y: 6160, z: 14 };
    const absent: Tile = { x: 4824, y: 6160, z: 14 };
    const ground = relief({ minimumSourceZoom: 14 }, (tile) => (tile.z === 14 && tile.x === absent.x ? "missing" : flatAnswer(10)));
    expect(ground.store.pendingWantedCount, "nothing wanted, nothing on its way").toBe(0);
    expect(await loadUntil(ground, [present], () => ground.state.frame.reliefOfZoom(present, present.z) !== undefined)).toBe(true);
    ground.store.requestTiles([present]);
    expect(ground.store.pendingWantedCount, "a resident terrain is in").toBe(0);
    ground.store.requestTiles([present, absent]);
    expect(ground.store.pendingWantedCount, "a tile on its way counts").toBe(1);
    expect(await loadUntil(ground, [present, absent], () => ground.store.pendingWantedCount === 0), "a tile the source has no terrain for is not on its way").toBe(true);
  });

  test("a tile without terrain of its own rises by its parent's", async () => {
    const ground = relief({ minimumSourceZoom: 12 }, (tile) => (tile.z === 15 ? "missing" : flatAnswer(10)));
    const tile: Tile = { x: 9647, y: 12321, z: 15 };
    expect(ground.state.frame.reliefOfZoom(tile, tile.z), "nothing is in before the first load").toBeUndefined();
    expect(ground.state.frame.reliefOfZoom(tile, tile.z)).toBeUndefined();
    expect(ground.source.asked, "a lookup starts no load: only the frame's demand does").toEqual([]);
    expect(await loadUntil(ground, [tile], () => ground.state.frame.reliefOfZoom(tile, tile.z) !== undefined)).toBe(true);
    const found = ground.state.frame.reliefOfZoom(tile, tile.z)!;
    expect(found.scale).toBe(0.5);
    expect([found.originX, found.originY]).toEqual([0.5, 0.5]);
    expect(found.terrain.size).toBe(2);
    expect(ground.textures.made.some((texture) => texture === found.texture), "an r16float texture of the fakes").toBe(true);
  });

  test("a tile without any terrain stays flat", async () => {
    const ground = relief({ minimumSourceZoom: 14 }, () => "missing");
    const tile: Tile = { x: 9647, y: 12321, z: 15 };
    await loadUntil(ground, [tile], () => false, 20);
    expect(ground.state.frame.reliefOfZoom(tile, tile.z)).toBeUndefined();
    expect(ground.store.statusSnapshot(true, 1, 0).wantedCount, "and stops asking").toBe(0);
  });

  test("one slot: the loads take the demand's order, and a lookup never starts one", async () => {
    const ground = relief({ minimumSourceZoom: 12, maximumConcurrentLoads: 1 }, () => flatAnswer(0));
    const tiles: Tile[] = [
      { x: 2412, y: 3080, z: 13 },
      { x: 2413, y: 3080, z: 13 },
      { x: 2412, y: 3081, z: 13 },
    ];
    ground.state.frame.reliefOfZoom(tiles[0]!, 13);
    expect(ground.state.frame.statusSnapshot().loadingCount, "a lookup starts no load").toBe(0);
    ground.store.requestTiles(tiles);
    expect(ground.state.frame.statusSnapshot().loadingCount, "one slot").toBe(1);
    expect(await loadUntil(ground, tiles, () => ground.state.frame.statusSnapshot().wantedResidentCount === 3)).toBe(true);
    expect(ground.source.asked.map(tileKey)).toEqual(tiles.map(tileKey));
  });

  test("a missing tile is wanted as its parent", async () => {
    const ground = relief({ minimumSourceZoom: 12 }, (tile) => (tile.z === 15 ? "missing" : flatAnswer(0)));
    const tile: Tile = { x: 9647, y: 12321, z: 15 };
    const parent = parentOf(tile, 14);
    const first = () => ground.state.frame.statusSnapshot().tiles[0];
    expect(await loadUntil(ground, [tile], () => sameTile(first()?.tile, parent) && first()?.state === "resident")).toBe(true);
    expect(first()).toMatchObject({ state: "resident", priority: 0, heightRange: { lowerBound: 0, upperBound: 0 }, seconds: 0, attempts: 0 });
    expect(ground.state.frame.statusSnapshot().missingCount).toBe(1);
  });

  test("the floor ends the search for a missing tile", async () => {
    // The source has nothing at zooms 12 and 13.
    const ground = relief({ minimumSourceZoom: 12 }, (tile) => (tile.z === 13 || tile.z === 12 ? "missing" : flatAnswer(100)));
    const deep: Tile = { x: 4823, y: 6160, z: 13 };
    const floor = parentOf(deep, 12);
    ground.state.setBands([flatRingBand(13, 1, 9, 13)]);
    expect(await loadUntil(ground, [deep], () => ground.state.frame.statusSnapshot().missingCount === 2), "zoom 13 is missing, then its parent at the floor").toBe(true);
    expect(ground.store.terrainSource(deep, 13), "the search ends at the floor").toEqual(floor);
    ground.store.requestTiles([deep]);
    expect(ground.state.frame.statusSnapshot().wantedCount, "nothing to load: no load goes below the floor").toBe(0);
    expect(ground.store.isResident(floor), "the source has nothing here: the tile is placed, flat").toBe(true);
    expect(ground.state.frame.relief(deep, floor), "bound to a tile that cannot come: drawn flat").toBeUndefined();
    expect(ground.source.asked.some((tile) => tile.z < 12)).toBe(false);
  });

  test("a tile the source does not answer for counts as in and flat", async () => {
    let answers = false;
    const clock = new FakeClock(1000);
    const ground = relief({ minimumSourceZoom: 12 }, () => (answers ? flatAnswer(100) : "fail"), clock);
    const tile: Tile = { x: 4823, y: 6160, z: 13 };
    ground.state.setBands([flatRingBand(13, 1, 9, 13)]);
    ground.store.requestTiles([tile]);
    await ground.source.answerAll();
    expect(ground.state.frame.statusSnapshot().loadingCount, "the first attempt fails").toBe(0);
    expect(ground.store.isResident(tile), "one failure may be a dropped connection").toBe(false);
    expect(ground.store.pendingWantedCount, "waiting out its pause").toBe(0);
    ground.store.requestTiles([tile]);
    expect(ground.source.pendingCount, "no retry before the pause is out").toBe(0);
    const versionBefore = ground.store.version;
    clock.seconds += GroundReliefLoadStates.retryBaseDelay + 1;
    expect(await loadUntil(ground, [tile], () => ground.store.isResident(tile)), "the second failure says the source is out of reach: in, and flat").toBe(true);
    expect(ground.state.frame.relief(tile, tile), "drawn flat").toBeUndefined();
    expect(ground.store.version, "the frame plans over it").not.toBe(versionBefore);
    answers = true;
    clock.seconds += GroundReliefLoadStates.retryMaximumDelay + 1;
    expect(await loadUntil(ground, [tile], () => ground.state.frame.relief(tile, tile) !== undefined), "the retries go on: the tile rises when the source answers").toBe(true);
  });

  test("a placement is bound to its ring's terrain", async () => {
    const ground = relief({ minimumSourceZoom: 12 }, (tile) => (tile.z === 13 ? "missing" : flatAnswer(100)));
    const tile: Tile = { x: 4823, y: 6160, z: 13 };
    const parent = parentOf(tile, 12);
    ground.state.setBands([flatRingBand(13, 1, 9, 13)]);
    expect(ground.store.terrainSource(tile, 13), "the ring's own, until the source says it has none").toEqual(tile);
    expect(ground.store.isResident(tile)).toBe(false);
    expect(ground.state.frame.relief(tile, tile), "not in: no relief, and no stand-in for it").toBeUndefined();
    expect(await loadUntil(ground, [tile], () => ground.store.isResident(parent))).toBe(true);
    expect(ground.store.terrainSource(tile, 13), "the finest the source has").toEqual(parent);
    const found = ground.state.frame.relief(tile, parent);
    expect(found?.scale, "placed in the zoom 12 terrain, half its side").toBe(0.5);
    expect(ground.state.frame.relief(parent, tile), "a terrain finer than the tile cannot raise it").toBeUndefined();
    ground.state.setActive(false);
    expect(ground.store.terrainSource(tile, 13), "collapsed, the rings' terrain is still named and kept: the rise back binds it at once").toEqual(parent);
    expect(ground.state.frame.relief(tile, parent), "and off the terrain nothing rises").toBeUndefined();
  });
});

describe("GroundReliefStore, the terrain's lifetime", () => {
  const tiles: Tile[] = [
    { x: 2412, y: 3080, z: 13 },
    { x: 2413, y: 3080, z: 13 },
    { x: 2412, y: 3081, z: 13 },
  ];
  const next: Tile = { x: 2413, y: 3081, z: 13 };

  test("the terrain lives while a frame wants it", async () => {
    const ground = relief({ minimumSourceZoom: 12, releasedCacheBytes: 0 }, () => flatAnswer(0));
    const status = () => ground.state.frame.statusSnapshot();
    expect(await loadUntil(ground, tiles, () => status().wantedResidentCount === 3)).toBe(true);
    ground.store.requestTiles([next]);
    expect(status().residentCount, "the three no frame wants any more went at once").toBe(0);
    expect(ground.textures.released.length, "their heights and their occlusions with them").toBe(6);
    expect(await loadUntil(ground, [next], () => ground.store.isResident(next))).toBe(true);
    expect(status().residentCount).toBe(1);
    expect(await loadUntil(ground, [tiles[0]!, next], () => ground.store.isResident(tiles[0]!))).toBe(true);
    expect(status().residentCount, "asked for again, it is loaded again").toBe(2);
    expect(ground.source.asked.filter((tile) => sameTile(tile, tiles[0]!)).length).toBe(2);
  });

  test("a load the frame stopped wanting lands into nothing", async () => {
    const ground = relief({ minimumSourceZoom: 12 }, () => flatAnswer(0));
    ground.store.requestTiles([next]);
    ground.store.requestTiles([]);
    await ground.source.answerAll();
    expect(ground.store.isResident(next)).toBe(false);
    expect(ground.state.frame.statusSnapshot().releasedCount, "never the frame's, so not kept").toBe(0);
    expect(ground.textures.released.length, "its heights and its occlusion let go").toBe(2);
    expect(ground.textures.released).toContain(ground.textures.made[0]);
  });

  test("a released tile comes back from the cache without a load", async () => {
    const ground = relief({ minimumSourceZoom: 12, releasedCacheBytes: 50 * 2 ** 20 }, () => flatAnswer(0));
    expect(await loadUntil(ground, tiles, () => ground.state.frame.statusSnapshot().wantedResidentCount === 3)).toBe(true);
    const costPerTile = ground.state.frame.statusSnapshot().residentBytes / 3;
    expect(costPerTile).toBeGreaterThan(0);
    const loadsBefore = ground.source.asked.length;
    const versionBefore = ground.store.version;
    ground.store.requestTiles([next]);
    let status = ground.state.frame.statusSnapshot();
    expect(status.residentCount, "the three no frame wants any more are not the frame's").toBe(0);
    expect(status.releasedCount, "they wait in the cache").toBe(3);
    expect(status.releasedBytes).toBe(costPerTile * 3);
    expect(ground.store.version).not.toBe(versionBefore);
    expect(ground.textures.released, "nothing let go").toEqual([]);
    expect(await loadUntil(ground, [next], () => ground.store.isResident(next))).toBe(true);
    ground.store.requestTiles([tiles[0]!, next]);
    expect(ground.store.isResident(tiles[0]!), "back from the cache at once").toBe(true);
    expect(ground.source.asked.length, "one load for the new tile, none for the tile back").toBe(loadsBefore + 1);
    status = ground.state.frame.statusSnapshot();
    expect(status.residentCount).toBe(2);
    expect(status.releasedCount).toBe(2);
    expect(ground.state.frame.relief(tiles[0]!, tiles[0]!), "read as a loaded tile is").toBeDefined();

    // Room for two tiles: the oldest released goes first.
    const small = relief({ minimumSourceZoom: 12, releasedCacheBytes: costPerTile * 2 }, () => flatAnswer(0));
    expect(await loadUntil(small, tiles, () => small.state.frame.statusSnapshot().wantedResidentCount === 3)).toBe(true);
    small.store.requestTiles([]);
    status = small.state.frame.statusSnapshot();
    expect(status.releasedCount, "two fit").toBe(2);
    expect(status.releasedBytes).toBeLessThanOrEqual(costPerTile * 2);
    expect(small.textures.released.length, "the first released was let go when the third came").toBeGreaterThan(0);
    small.store.requestTiles([tiles[0]!]);
    expect(small.store.isResident(tiles[0]!) && small.state.frame.statusSnapshot().releasedCount === 2, "the first released was let go: it loads again").toBe(false);
    expect(small.store.isResident(tiles[0]!)).toBe(false);
    small.store.removeAll();
    expect(small.state.frame.statusSnapshot().releasedCount, "a memory warning empties the cache too").toBe(0);
  });
});

/** A store serving terrain tiles of 4 by 4 texels, each of one height, none elsewhere. */
function weldStore(metresByTile: [Tile, number][]): TestRelief {
  const byKey = new Map(metresByTile.map(([tile, metres]) => [tileKey(tile), metres]));
  return relief({ minimumSourceZoom: 0 }, (tile) => {
    const metres = byKey.get(tileKey(tile));
    return metres === undefined ? "missing" : flatAnswer(metres, 4);
  });
}

describe("GroundReliefStore, the edges' weld", () => {
  test("neighbours of one zoom meet with one height in any order", async () => {
    const west: Tile = { x: 100, y: 100, z: 8 };
    const east: Tile = { x: 101, y: 100, z: 8 };
    for (const order of [
      [west, east],
      [east, west],
    ]) {
      const ground = weldStore([
        [west, 100],
        [east, 200],
      ]);
      const loaded: Tile[] = [];
      for (const tile of order) {
        loaded.push(tile);
        expect(await loadUntil(ground, loaded, () => ground.state.frame.statusSnapshot().wantedResidentCount === loaded.length)).toBe(true);
        ground.state.beginFrame();
      }
      const westRelief = ground.state.frame.reliefOfZoom(west, 8, false)!;
      const eastRelief = ground.state.frame.reliefOfZoom(east, 8, false)!;
      expectClose(westRelief.metresAtTileUV(1, 0.5), 150, 0.01, "the west side of the edge");
      expectClose(eastRelief.metresAtTileUV(0, 0.5), 150, 0.01, "the east side of the edge");
      expectClose(westRelief.metresAtTileUV(0.5, 0.5), 100, 0.01, "the inside keeps its height");
      expectClose(FakeReliefTextures.metres(westRelief.texture, 3, 1), 150, 0.01, "the texture took the weld");
      expectClose(FakeReliefTextures.metres(eastRelief.texture, 0, 2), 150, 0.01);
      expectClose(FakeReliefTextures.metres(westRelief.texture, 0, 1), 100, 0.01, "an edge with no neighbour in is left as decoded");
    }
  });

  test("four tiles meet at their corner with one height", async () => {
    const northWest: Tile = { x: 100, y: 100, z: 8 };
    const northEast: Tile = { x: 101, y: 100, z: 8 };
    const southWest: Tile = { x: 100, y: 101, z: 8 };
    const southEast: Tile = { x: 101, y: 101, z: 8 };
    const ground = weldStore([
      [northWest, 100],
      [northEast, 200],
      [southWest, 300],
      [southEast, 400],
    ]);
    const tiles = [northWest, northEast, southWest, southEast];
    expect(await loadUntil(ground, tiles, () => ground.state.frame.statusSnapshot().wantedResidentCount === 4)).toBe(true);
    expect(ground.store.applyPendingWelds()).toBe(true);
    const reliefs = tiles.map((tile) => ground.state.frame.reliefOfZoom(tile, 8, false)!);
    expectClose(reliefs[0]!.metresAtTileUV(1, 1), 250, 0.01);
    expectClose(reliefs[1]!.metresAtTileUV(0, 1), 250, 0.01);
    expectClose(reliefs[2]!.metresAtTileUV(1, 0), 250, 0.01);
    expectClose(reliefs[3]!.metresAtTileUV(0, 0), 250, 0.01);
    expectClose(reliefs[0]!.metresAtTileUV(0.5, 1), 200, 0.01, "the north-west and south-west edge");
    expectClose(FakeReliefTextures.metres(reliefs[3]!.texture, 0, 0), 250, 0.01);
    expect(ground.store.applyPendingWelds(), "nothing left to write").toBe(false);
  });

  test("a weld moves the version and the tile's revision and height range", async () => {
    const west: Tile = { x: 100, y: 100, z: 8 };
    const east: Tile = { x: 101, y: 100, z: 8 };
    const ground = weldStore([
      [west, 100],
      [east, 300],
    ]);
    expect(await loadUntil(ground, [west, east], () => ground.state.frame.statusSnapshot().wantedResidentCount === 2)).toBe(true);
    const terrain = ground.state.frame.reliefOfZoom(west, 8, false)!.terrain;
    const version = ground.store.version;
    expect(terrain.revision).toBe(0);
    expect(ground.store.applyPendingWelds()).toBe(true);
    expect(ground.store.version, "what is placed on the CPU is placed again").toBe(version + 1);
    expect(terrain.revision).toBeGreaterThan(0);
    expect(terrain.heightRange, "the welded edge counts").toEqual({ lowerBound: 100, upperBound: 200 });
    expect(halfBitsToFloat(terrain.originalEdges.east[1]!), "the decoded edge kept").toBe(100);
    expect(ground.store.heightRangeMetres).toEqual({ lowerBound: 100, upperBound: 300 });
  });

  test("north and south neighbours rise by the frame's one scale", async () => {
    const north: Tile = { x: 100, y: 100, z: 8 };
    const south: Tile = { x: 100, y: 101, z: 8 };
    const ground = weldStore([
      [north, 300],
      [south, 500],
    ]);
    expect(await loadUntil(ground, [north, south], () => ground.state.frame.statusSnapshot().wantedResidentCount === 2)).toBe(true);
    ground.store.applyPendingWelds();
    ground.state.setWorldScale([0.39, 0.39], 1_000_000);
    expect(ground.state.frame.worldUnitsPerMetre).toBeGreaterThan(0);
    const northLift = GroundReliefTileLift.make(ground.state.frame, north, north)!;
    const southLift = GroundReliefTileLift.make(ground.state.frame, south, south)!;
    expect(northLift.unitsPerMetre).toBe(southLift.unitsPerMetre);
    expect(northLift.worldUnits(0.5, 1), "the shared edge rises as one").toBe(southLift.worldUnits(0.5, 0));
    expect(GroundReliefTileLift.make(ground.state.frame, north, undefined), "a placement on the plane is not lifted").toBeUndefined();
  });

  test("the terrain texture spans its tile's side over its share", async () => {
    const ground = relief({ minimumSourceZoom: 0 }, () => flatAnswer(0));
    const parent: Tile = { x: 0, y: 0, z: 1 };
    expect(await loadUntil(ground, [parent], () => ground.state.frame.reliefOfZoom(parent, 1) !== undefined)).toBe(true);
    const child: Tile = { x: 1, y: 1, z: 2 };
    const found = ground.state.frame.reliefOfZoom(child, 1, false)!;
    expect(found.scale).toBe(0.5);
    const renderMapSize = 1_000_000;
    const unitsPerMetre = GroundReliefUniform.worldUnitsPerMetre(0.625, renderMapSize);
    const metres = GroundReliefUniform.terrainSideMetres(found, child, unitsPerMetre, renderMapSize);
    expectClose(metres * unitsPerMetre, renderMapSize / 2, 1);
  });
});

describe("GroundReliefStore, the occlusion of the sky", () => {
  test("a new key computes every tile in and kept again, a few a frame", async () => {
    const ground = relief({ minimumSourceZoom: 12 }, () => flatAnswer(0));
    const tiles: Tile[] = Array.from({ length: 6 }, (_, index) => ({ x: 2400 + index, y: 3080, z: 13 }));
    expect(await loadUntil(ground, tiles, () => ground.state.frame.statusSnapshot().wantedResidentCount === 6)).toBe(true);
    expect(ground.state.frame.statusSnapshot().occlusionComputedCount, "computed as each tile came").toBe(6);
    const frames: (() => void)[] = [];
    ground.store.schedule = (step) => frames.push(step);
    const computedBefore = ground.textures.occlusions.length;
    const releasedBefore = ground.textures.released.length;
    ground.state.setOcclusion({ ...defaultTerrainOcclusion, radiusMeters: defaultTerrainOcclusion.radiusMeters / 2 }, false);
    expect(ground.textures.occlusions.length - computedBefore, "the first frame's share").toBe(4);
    expect(ground.state.frame.statusSnapshot().occlusionComputedCount).toBe(4);
    expect(frames.length).toBe(1);
    frames.shift()!();
    expect(ground.state.frame.statusSnapshot().occlusionComputedCount, "the rest on the next frame").toBe(6);
    expect(frames.length).toBe(0);
    expect(ground.store.terrain(tiles[0]!)?.occlusion, "drawn with the new one").toBeDefined();
    expect(ground.textures.released.length - releasedBefore, "the old ones let go").toBe(6);
  });
});

describe("GroundReliefStore, the planner's demand", () => {
  const street = { tile: { x: 38500, y: 51240, z: 17 }, worldWrap: 0 };
  const point: [number, number] = [(38500 + 0.5) / 2 ** 17, (51240 + 0.5) / 2 ** 17];
  const request = (tileZoom: number, onFlatMap = true) => ({ onFlatMap, tileZoom, targets: [street], shown: [], missing: [], centerWorldMercator: point });

  test("asked on the terrain, past it for the collapse zoom's tiles, and nothing below the relief's zoom or off the flat map", () => {
    const ground = relief({ minimumSourceZoom: 12, appearZoom: 10, collapseZoom: 13.7 }, () => flatAnswer(0));
    const wanted = () => ground.store.statusSnapshot(true, 1, 0).tiles.filter((status) => status.priority !== undefined).map((status) => status.tile);
    ground.store.request(request(17));
    expect(wanted().some((tile) => tile.z === 17), "on the terrain, the street tile's own").toBe(true);
    ground.state.setActive(false);
    ground.store.request(request(17));
    expect(wanted().some((tile) => tile.z > 13), "collapsed past the relief's zooms, no finer than the collapse's tile zoom").toBe(false);
    expect(wanted().some((tile) => sameTile(tile, parentOf(street.tile, 13)))).toBe(true);
    ground.store.request(request(9));
    expect(ground.store.statusSnapshot(true, 1, 0).wantedCount, "below the relief's zoom").toBe(0);
    ground.state.setActive(true);
    ground.store.request(request(17, false));
    expect(ground.store.statusSnapshot(true, 1, 0).wantedCount, "off the flat map").toBe(0);
  });
});
