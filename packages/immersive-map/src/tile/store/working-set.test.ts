// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The working set's frame: what it hands the loader, what it places and when
// it stays idle. No Swift test covers the subsystem's update, which needs a
// Metal frame there. These follow its doc comments.

import { describe, expect, test } from "vitest";
import { defaultPresentationSettings } from "../../configuration/presentation-settings.ts";
import { inOwnSlot, type VisibleTile } from "../placement/place-tile.ts";
import { type Tile, tileKey } from "../tile.ts";
import { VisibleContentState } from "../visibility/visible-content-state.ts";
import { TileWorkingSetStore } from "./tile-working-set-store.ts";
import { TileWorkingSet, type TileWorkingSetFrame, type WorkingSetTile } from "./working-set.ts";

class RecordingLoader {
  readonly requests: string[][] = [];
  cancelled = 0;
  request(tiles: readonly Tile[]): void {
    this.requests.push(tiles.map(tileKey));
  }
  cancelAll(): void {
    this.cancelled += 1;
  }
}

const resident = (tile: Tile): WorkingSetTile => ({ tile, groundIsFlattened: true, keepsBuildingsByQuarters: false });
const v = (x: number, y: number, z: number, worldWrap = 0): VisibleTile => ({ tile: { x, y, z }, worldWrap });
const parent: Tile = { x: 8, y: 8, z: 4 };
const targets = [v(16, 16, 5), v(17, 16, 5), v(16, 17, 5), v(17, 17, 5)];

function frame(coverageVersion: number, renderSurfaceMode: "flat" | "spherical" = "flat"): TileWorkingSetFrame {
  return {
    visibleContent: VisibleContentState.make([0.5, 0.5], { tileX: 16, tileY: 16 }, targets, 5, coverageVersion),
    renderSurfaceMode,
    transition: renderSurfaceMode === "flat" ? 1 : 0,
    presentation: defaultPresentationSettings,
    reliefActive: false,
  };
}

function makeWorkingSet() {
  const store = new TileWorkingSetStore<WorkingSetTile>();
  const loader = new RecordingLoader();
  return { store, loader, workingSet: new TileWorkingSet({ store, loader }) };
}

describe("TileWorkingSet", () => {
  test("the loader gets the missing targets nearest first, the world tile last on the plane", () => {
    const { loader, workingSet } = makeWorkingSet();
    const state = workingSet.update(frame(1));
    expect(loader.requests).toHaveLength(1);
    const request = loader.requests[0]!;
    expect(request.at(-1)).toBe(tileKey(TileWorkingSet.horizonBackdropTile));
    expect(new Set(request.slice(0, -1))).toEqual(new Set(targets.map((t) => tileKey(t.tile))));
    expect(state.requestedTilesCount).toBe(5);
    expect(state.readyTilesCount).toBe(0);
    expect(state.placeTilesContext.tilePlacements).toEqual([]);
  });

  test("the globe asks for no backdrop before the air handover", () => {
    const { loader, workingSet } = makeWorkingSet();
    workingSet.update(frame(1, "spherical"));
    expect(loader.requests[0]).not.toContain(tileKey(TileWorkingSet.horizonBackdropTile));
  });

  test("a resident parent stands in, the backdrop lies under it, and the targets replace it as they land", () => {
    const { store, workingSet } = makeWorkingSet();
    store.insert(resident(parent));
    store.insert(resident(TileWorkingSet.horizonBackdropTile));
    let state = workingSet.update(frame(1));
    const placements = state.placeTilesContext.tilePlacements;
    expect(placements.filter((p) => !p.isHorizonBackdrop).map((p) => tileKey(p.resident.tile))).toEqual(targets.map(() => tileKey(parent)));
    expect(placements.filter((p) => p.isHorizonBackdrop)).toHaveLength(1);
    expect(store.contains(parent), "the stand-in is kept").toBe(true);

    for (const target of targets) store.insert(resident(target.tile));
    state = workingSet.update(frame(1));
    const ground = state.placeTilesContext.tilePlacements.filter((p) => !p.isHorizonBackdrop);
    expect(ground.every(inOwnSlot)).toBe(true);
    expect(ground).toHaveLength(4);
    expect(state.readyTilesCount, "the targets and the world tile").toBe(5);
    // The last frame still showed the parent, so the store kept it. It goes
    // with the next demand pass, once no frame shows it.
    expect(store.contains(parent), "kept while the last frame showed it").toBe(true);
    workingSet.update(frame(2));
    expect(store.contains(parent), "the parent goes once nothing shows it").toBe(false);
  });

  test("the gate keeps the working set idle when nothing moved", () => {
    const { store, loader, workingSet } = makeWorkingSet();
    for (const target of targets) store.insert(resident(target.tile));
    store.insert(resident(TileWorkingSet.horizonBackdropTile));
    const first = workingSet.update(frame(1));
    expect(first.requestedTilesCount).toBe(0);
    const requests = loader.requests.length;
    const again = workingSet.update(frame(1));
    expect(loader.requests.length, "nothing asked of the loader").toBe(requests);
    expect(again).toBe(first);
    const moved = workingSet.update(frame(2));
    expect(moved.placementVersion).toBeGreaterThan(first.placementVersion);
  });

  test("a memory warning stops the loads and replans", () => {
    const { store, loader, workingSet } = makeWorkingSet();
    for (const target of targets) store.insert(resident(target.tile));
    const first = workingSet.update(frame(1));
    workingSet.handleMemoryWarning();
    expect(loader.cancelled).toBe(1);
    const next = workingSet.update(frame(1));
    expect(next.placementVersion).toBeGreaterThan(first.placementVersion);
    expect(next.placeTilesContext.tilePlacements.filter((p) => !p.isHorizonBackdrop)).toHaveLength(4);
    workingSet.evict();
    expect(store.residentTileCount).toBe(0);
    expect(workingSet.update(frame(1)).placeTilesContext.tilePlacements).toEqual([]);
  });
});
