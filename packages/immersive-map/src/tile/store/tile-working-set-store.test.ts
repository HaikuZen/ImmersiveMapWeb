// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileWorkingSetStoreTests`: residency is the demanded
// set, the pinned world cover, and the tiles that stand in for a demanded
// tile that has not arrived (its resident descendants, its finest resident
// ancestor). Nothing else survives a demand update, and nothing is
// remembered between two of them.

import { describe, expect, test } from "vitest";
import type { ResidentTile } from "../placement/place-tile.ts";
import { type Tile, tileKey } from "../tile.ts";
import { TileWorkingSetStore } from "./tile-working-set-store.ts";

/** The Swift fixture's 16-byte backing buffer. */
const tileBytes = 16;
const makeStore = () => new TileWorkingSetStore<ResidentTile>({ byteSize: () => tileBytes });
const resident = (tile: Tile): ResidentTile => ({ tile });
const t = (x: number, y: number, z: number): Tile => ({ x, y, z });
const quad = (z: number, x0: number, y0: number) => [0, 1, 2, 3].map((i) => t(x0 + (i % 2), y0 + Math.floor(i / 2), z));

describe("TileWorkingSetStore", () => {
  test("a demanded tile stays resident across demand updates", () => {
    const store = makeStore();
    const tile = t(5, 6, 10);
    store.insert(resident(tile));
    store.updateDemandedTiles([tile]);
    store.updateDemandedTiles([tile]);
    expect(store.get(tile)).toBeDefined();
  });

  test("a tile leaving the demand with nothing to stand in for is released at once", () => {
    const store = makeStore();
    const staying = t(1, 0, 10);
    const leaving = t(2, 0, 10);
    store.insert(resident(staying));
    store.insert(resident(leaving));
    store.updateDemandedTiles([staying]);
    expect(store.get(staying)).toBeDefined();
    expect(store.get(leaving), "no retention: a tile the demand does not name and nothing needs goes").toBeUndefined();
    expect(store.residentTileCount).toBe(1);
  });

  test("an insert outside the demand is held until the demand speaks", () => {
    // Offscreen harnesses parse tiles before any frame has demanded them: the
    // store must hold such a tile until demand actually speaks.
    const store = makeStore();
    const tile = t(3, 3, 12);
    store.insert(resident(tile));
    expect(store.get(tile)).toBeDefined();
    store.updateDemandedTiles([]);
    expect(store.get(tile)).toBeUndefined();
  });

  test("descendants of a loading target stay until it lands", () => {
    // A zoom-out: the z16 tiles on screen stay while their z14 parent loads,
    // and go the moment it is resident.
    const store = makeStore();
    const parent = t(10, 10, 14);
    const children = quad(16, 40, 40);
    const stranger = t(90, 90, 16);
    for (const tile of [...children, stranger]) store.insert(resident(tile));
    store.updateDemandedTiles([...children, stranger]);

    store.updateDemandedTiles([parent]);
    for (const child of children) expect(store.get(child), `${tileKey(child)} stands in for the loading parent`).toBeDefined();
    expect(store.get(stranger), "a tile under no loading target goes").toBeUndefined();

    store.insert(resident(parent));
    store.updateDemandedTiles([parent]);
    for (const child of children) expect(store.get(child), `${tileKey(child)} is released once the parent is resident`).toBeUndefined();
    expect(store.get(parent)).toBeDefined();
  });

  test("descendants stay at any depth", () => {
    const store = makeStore();
    const target = t(1, 1, 5);
    const deep = t(1 << 11, 1 << 11, 16);
    const unrelated = t(3 << 11, 1 << 11, 16);
    store.insert(resident(deep));
    store.insert(resident(unrelated));
    store.updateDemandedTiles([target]);
    expect(store.get(deep)).toBeDefined();
    expect(store.get(unrelated), "under no loading target, it goes").toBeUndefined();
    store.insert(resident(target));
    store.updateDemandedTiles([target]);
    expect(store.get(deep), "released once the ancestor lands").toBeUndefined();
  });

  test("the finest resident ancestor of a loading target stays until its children land", () => {
    // A zoom-in: the z14 tile on screen stays while its z16 children load,
    // and goes once every child that is demanded has landed.
    const store = makeStore();
    const parent = t(10, 10, 14);
    const grandparent = t(5, 5, 13);
    const children = quad(16, 40, 40);
    store.insert(resident(parent));
    store.insert(resident(grandparent));
    store.updateDemandedTiles([parent, grandparent]);

    store.updateDemandedTiles(children);
    expect(store.get(parent), "the finest resident ancestor stands in").toBeDefined();
    expect(store.get(grandparent), "a coarser ancestor is not drawn and not kept").toBeUndefined();

    for (const child of children.slice(0, -1)) store.insert(resident(child));
    store.updateDemandedTiles(children);
    expect(store.get(parent), "one child still loading keeps the parent").toBeDefined();

    store.insert(resident(children.at(-1)!));
    store.updateDemandedTiles(children);
    expect(store.get(parent), "every child resident, the parent goes").toBeUndefined();
  });

  test("a stand-in is released when its target leaves the demand", () => {
    const store = makeStore();
    const parent = t(10, 10, 14);
    const child = t(40, 40, 16);
    store.insert(resident(child));
    store.updateDemandedTiles([parent]);
    expect(store.get(child)).toBeDefined();
    store.updateDemandedTiles([t(11, 11, 14)]);
    expect(store.get(child), "the camera moved on: nothing needs the child any more").toBeUndefined();
  });

  test("nothing is remembered between demand updates", () => {
    // The same demand given twice releases the same tiles: no queue, no
    // history, only the set and what is resident.
    const store = makeStore();
    const target = t(10, 10, 14);
    const child = t(40, 40, 16);
    store.insert(resident(child));
    store.updateDemandedTiles([target]);
    store.updateDemandedTiles([target]);
    expect(store.get(child)).toBeDefined();
    store.insert(resident(target));
    store.updateDemandedTiles([target]);
    expect(store.get(child)).toBeUndefined();
    expect(store.residentTileCount).toBe(1);
  });

  test("what the last frame showed stays while the demand does not name it", () => {
    const store = makeStore();
    const shown = t(7, 7, 12);
    store.insert(resident(shown));
    store.updateDemandedTiles([t(1, 1, 12)], new Set([tileKey(shown)]));
    expect(store.contains(shown)).toBe(true);
    store.updateDemandedTiles([t(1, 1, 12)]);
    expect(store.contains(shown)).toBe(false);
  });

  test("the resident tiles list the stand-ins too", () => {
    const store = makeStore();
    const active = t(1, 0, 10);
    const standIn = t(2, 0, 12);
    store.insert(resident(active));
    store.insert(resident(standIn));
    store.updateDemandedTiles([active, t(1, 0, 11)]);
    expect(new Set(store.residentTiles().keys())).toEqual(new Set([tileKey(active), tileKey(standIn)]));
  });

  test("contains follows residency without a trace", () => {
    const events: string[] = [];
    const store = new TileWorkingSetStore<ResidentTile>({ byteSize: () => tileBytes, trace: (event) => events.push(event.kind) });
    const pinned = t(0, 0, 0);
    const ordinary = t(1, 1, 4);
    expect(store.contains(ordinary)).toBe(false);
    store.insert(resident(pinned));
    store.insert(resident(ordinary));
    expect(store.contains(ordinary)).toBe(true);
    store.updateDemandedTiles([]);
    expect(store.contains(ordinary), "released on leaving the demand").toBe(false);
    expect(store.contains(pinned), "the pinned world cover stays").toBe(true);
    expect(events).toEqual(["insert", "insert", "release"]);
  });

  test("the world cover is pinned across demand updates", () => {
    const store = makeStore();
    const pinned = t(0, 0, 0);
    const ordinary = t(1, 1, 1);
    store.insert(resident(pinned));
    store.insert(resident(ordinary));
    store.updateDemandedTiles([]);
    expect(store.get(pinned), "the z0 world cover must survive leaving demand").toBeDefined();
    expect(store.get(ordinary), "z1 is past the pinned cover and is released").toBeUndefined();
  });

  test("the pinned cover is never a stand-in that keeps anything", () => {
    // A loading z1 target has only the pinned ancestor: nothing to keep,
    // nothing to release.
    const store = makeStore();
    const pinned = t(0, 0, 0);
    store.insert(resident(pinned));
    store.updateDemandedTiles([t(0, 0, 1)]);
    expect(store.get(pinned)).toBeDefined();
    expect(store.residentTileCount).toBe(1);
  });

  test("a memory warning releases the undemanded world cover and keeps the demanded tiles", () => {
    // The resident demanded z13 is the loading z14's finest resident
    // ancestor, so the cover under both stands in for nothing.
    const store = makeStore();
    const demanded = t(5, 5, 13);
    const hidden = t(0, 0, 0);
    const loading = t(10, 10, 14);
    const standIn = t(40, 40, 16);
    store.insert(resident(demanded));
    store.insert(resident(hidden));
    store.insert(resident(standIn));
    store.updateDemandedTiles([demanded, loading]);
    expect(store.get(standIn)).toBeDefined();
    expect(store.get(hidden), "the cover is pinned while nothing presses").toBeDefined();

    store.releaseUndemandedTiles();

    expect(store.get(demanded), "the demanded set stays so the map does not blank").toBeDefined();
    expect(store.get(hidden), "the pinned cover outside demand is handed back under pressure").toBeUndefined();
    expect(store.get(standIn), "what the frame draws under a loading target stays").toBeDefined();
  });

  test("a memory warning keeps the cover standing in on the sphere", () => {
    // The sphere has no backdrop: a loading z5 target is drawn from its
    // finest resident ancestor, the pinned cover here, which a warning
    // therefore keeps. Under no loading target the cover goes.
    const cover = t(0, 0, 0);
    const standingIn = makeStore();
    standingIn.insert(resident(cover));
    standingIn.updateDemandedTiles([t(16, 16, 5)]);
    standingIn.releaseUndemandedTiles();
    expect(standingIn.get(cover)).toBeDefined();

    const idle = makeStore();
    idle.insert(resident(cover));
    idle.updateDemandedTiles([]);
    idle.releaseUndemandedTiles();
    expect(idle.get(cover)).toBeUndefined();
  });

  test("a memory warning releases what no frame needs", () => {
    const store = makeStore();
    const orphan = t(7, 7, 12);
    store.insert(resident(orphan));
    const before = store.contentVersion;
    store.releaseUndemandedTiles();
    expect(store.get(orphan), "a tile no demand has spoken for goes").toBeUndefined();
    expect(store.contentVersion).not.toBe(before);
    store.releaseUndemandedTiles();
    expect(store.residentTileCount).toBe(0);
  });

  test("remove all clears everything and allows a reinsert", () => {
    const store = makeStore();
    const tile = t(0, 0, 0);
    store.insert(resident(tile));
    store.removeAll();
    expect(store.get(tile)).toBeUndefined();
    expect(store.residentTileCount).toBe(0);
    expect(store.residentByteCount).toBe(0);
    store.insert(resident(tile));
    expect(store.get(tile)).toBeDefined();
  });

  test("the content version bumps on insert but not on a demand update release", () => {
    const store = makeStore();
    const leaving = t(1000, 1000, 12);
    const tile = t(9, 9, 9);
    store.insert(resident(leaving));
    store.updateDemandedTiles([leaving]);
    const initialVersion = store.contentVersion;

    store.insert(resident(tile));
    store.updateDemandedTiles([tile, leaving]);
    const afterInsert = store.contentVersion;
    expect(afterInsert).not.toBe(initialVersion);

    store.updateDemandedTiles([tile]);
    expect(store.get(leaving)).toBeUndefined();
    expect(store.get(tile)).toBeDefined();
    expect(store.contentVersion, "a demand-update release must not re-trigger the demand gate that caused it").toBe(afterInsert);
  });

  test("the content version bumps on a memory warning release", () => {
    const store = makeStore();
    const tile = t(0, 0, 0);
    store.insert(resident(tile));
    store.updateDemandedTiles([]);
    const beforeWarning = store.contentVersion;
    store.releaseUndemandedTiles();
    expect(store.contentVersion, "dropping the pinned cover changes what a demand pass would find").not.toBe(beforeWarning);
  });

  test("the resident byte count follows inserts and releases", () => {
    const store = makeStore();
    const first = t(1, 2, 10);
    const second = t(2, 2, 10);
    store.insert(resident(first));
    const afterFirst = store.residentByteCount;
    expect(afterFirst).toBeGreaterThan(0);
    store.insert(resident(second));
    expect(store.residentByteCount).toBeGreaterThan(afterFirst);
    expect(store.residentTileCount).toBe(2);
    store.updateDemandedTiles([first]);
    expect(store.residentByteCount, "the released tile's bytes are handed back").toBe(afterFirst);
    store.updateDemandedTiles([]);
    expect(store.residentTileCount).toBe(0);
    expect(store.residentByteCount).toBe(0);
  });

  test("a replacing insert keeps one entry and consistent bytes", () => {
    const store = makeStore();
    const tile = t(4, 4, 11);
    store.insert(resident(tile));
    const bytes = store.residentByteCount;
    store.insert(resident(tile));
    expect(store.residentTileCount).toBe(1);
    expect(store.residentByteCount).toBe(bytes);
    expect(store.get(tile)).toBeDefined();
  });

  // A superseded parse: the old tiles stand in until the new ones land.

  test("a stale tile is drawn but not contained, so the demand asks for it again", () => {
    const store = makeStore();
    const tile = t(5, 6, 10);
    store.insertStale(resident(tile));
    expect(store.residentTiles().has(tileKey(tile)), "drawn as any resident").toBe(true);
    expect(store.contains(tile), "the demand wants its replacement").toBe(false);
    expect(store.isStale(tile)).toBe(true);
    store.updateDemandedTiles([tile]);
    expect(store.get(tile), "kept while demanded").toBeDefined();
  });

  test("a fresh insert replaces a stale tile and ends its staleness", () => {
    const store = makeStore();
    const tile = t(5, 6, 10);
    const old = resident(tile);
    const fresh = resident(tile);
    store.insertStale(old);
    store.insert(fresh);
    expect(store.get(tile)).toBe(fresh);
    expect(store.contains(tile)).toBe(true);
    expect(store.isStale(tile)).toBe(false);
  });

  test("a stale tile nothing needs is released, the world cover too", () => {
    const store = makeStore();
    const leaving = t(2, 0, 10);
    const cover = t(0, 0, 0);
    store.insertStale(resident(leaving));
    store.insertStale(resident(cover));
    store.updateDemandedTiles([t(1, 0, 10)]);
    expect(store.get(leaving)).toBeUndefined();
    expect(store.get(cover), "a stale cover is not pinned: it comes back fresh when asked for").toBeUndefined();
    // A fresh cover stays pinned, as before.
    store.insert(resident(cover));
    store.updateDemandedTiles([t(1, 0, 10)]);
    expect(store.get(cover)).toBeDefined();
  });

  test("a stale ancestor stands in for its loading children, and goes once they land", () => {
    const store = makeStore();
    const parent = t(4, 4, 9);
    const children = quad(10, 8, 8);
    store.insertStale(resident(parent));
    store.updateDemandedTiles(children);
    expect(store.get(parent), "the old parent covers the children that are on their way").toBeDefined();
    for (const child of children) store.insert(resident(child));
    store.updateDemandedTiles(children);
    expect(store.get(parent)).toBeUndefined();
  });
});
