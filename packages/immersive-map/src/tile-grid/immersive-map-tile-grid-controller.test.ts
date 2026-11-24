// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The Swift `ImmersiveMapTileGridControllerTests` and `TileGridSelectionTests`.

import { describe, expect, test } from "vitest";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { ImmersiveMapTileID } from "../geo/immersive-map-tile-id.ts";
import { ImmersiveMapSelectionHandler } from "../selection/immersive-map-selection-handler.ts";
import { ImmersiveMapSelectionController } from "../selection/immersive-map-selection.ts";
import type { SelectableMapFeature } from "../selection/selectable-map-feature.ts";
import { ImmersiveMapTileGridController, type ImmersiveMapTileGridSelectionChange, type ImmersiveMapTileGridTapRejection } from "./immersive-map-tile-grid-controller.ts";
import { TileGridSelectionSnapshot } from "./selection/tile-grid-selection-snapshot.ts";
import { TileGridSelection } from "./selection/tile-grid-selection.ts";
import { TileGridFrame } from "./tile-grid-frame.ts";

const tile = (x: number, y: number, zoom = 15): ImmersiveMapTileID => ImmersiveMapTileID.make(zoom, x, y);
const anywhere = { latitude: 55.75, longitude: 37.62 };
const point = { x: 10, y: 20 };
const free = { mode: "multiple", limit: null, selectableBounds: null } as const;

function watched(controller: ImmersiveMapTileGridController) {
  const changes: ImmersiveMapTileGridSelectionChange[] = [];
  const rejections: ImmersiveMapTileGridTapRejection[] = [];
  let frames = 0;
  controller.onSelectionChanged = (change) => changes.push(change);
  controller.onTapRejected = (rejection) => rejections.push(rejection);
  const owner = {};
  controller.setChangeHandler(() => frames++, owner);
  return { changes, rejections, owner, frames: () => frames };
}

describe("ImmersiveMapTileGridController", () => {
  test("a change from code is reported with what it added and removed", () => {
    const grid = new ImmersiveMapTileGridController([tile(1, 1)]);
    const watch = watched(grid);
    grid.select([tile(2, 2), tile(3, 3), tile(1, 1)]);
    expect(watch.changes).toHaveLength(1);
    expect(watch.changes[0]!.added.map(ImmersiveMapTileID.key)).toEqual(["15/2/2", "15/3/3"]);
    expect(watch.changes[0]!.removed).toEqual([]);
    expect(watch.changes[0]!.source).toBe("programmatic");
    expect(watch.changes[0]!.selectedTiles).toHaveLength(3);
    grid.deselect(tile(2, 2));
    expect(watch.changes[1]!.removed.map(ImmersiveMapTileID.key)).toEqual(["15/2/2"]);
    expect(grid.isSelected(tile(2, 2))).toBe(false);
    expect(grid.selectedCount).toBe(2);
    expect(watch.frames()).toBe(2);
  });

  test("a call that leaves the selection as it was reports nothing and asks for no frame", () => {
    const grid = new ImmersiveMapTileGridController([tile(1, 1)]);
    const watch = watched(grid);
    grid.select(tile(1, 1));
    grid.deselect(tile(9, 9));
    grid.setSelectedTiles([tile(1, 1)]);
    expect(watch.changes).toEqual([]);
    expect(watch.frames()).toBe(0);
    expect(grid.selectionRevision).toBe(0);
  });

  test("toggle, replace and clear", () => {
    const grid = new ImmersiveMapTileGridController();
    expect(grid.toggle(tile(1, 1))).toBe(true);
    expect(grid.toggle(tile(1, 1))).toBe(false);
    grid.setSelectedTiles([tile(4, 4), tile(5, 5)]);
    // The selection handed back to itself stays.
    grid.setSelectedTiles(grid.selectedTiles);
    expect(grid.selectedTiles.map(ImmersiveMapTileID.key)).toEqual(["15/4/4", "15/5/5"]);
    grid.clearSelection();
    expect(grid.selectedTiles).toEqual([]);
  });

  test("a tile is the same tile however its numbers are written", () => {
    const grid = new ImmersiveMapTileGridController();
    grid.select({ zoom: 2, x: 5, y: 1 });
    expect(grid.isSelected({ zoom: 2, x: 1, y: 1 })).toBe(true);
    expect([...grid.selectionTriples()]).toEqual([2, 1, 1]);
  });

  test("a tap selects, and a second tap takes the tile back", () => {
    const grid = new ImmersiveMapTileGridController();
    const watch = watched(grid);
    expect(grid.applyTap(tile(1, 1), free, anywhere, point)).toBe("toggled");
    expect(grid.isSelected(tile(1, 1))).toBe(true);
    expect(watch.changes[0]!.source).toBe("tap");
    expect(grid.applyTap(tile(1, 1), free, anywhere, point)).toBe("toggled");
    expect(grid.selectedTiles).toEqual([]);
  });

  test("a tap past the limit selects nothing and is reported, and a selected tile can still be taken back", () => {
    const grid = new ImmersiveMapTileGridController([tile(1, 1), tile(2, 2)]);
    const watch = watched(grid);
    const rules = { ...free, limit: 2 };
    expect(grid.applyTap(tile(3, 3), rules, anywhere, point)).toBe("rejected");
    expect(watch.rejections).toEqual([{ tile: tile(3, 3), reason: { kind: "limitReached", limit: 2 }, coordinate: anywhere, screenPoint: point }]);
    expect(grid.selectedCount).toBe(2);
    expect(grid.applyTap(tile(1, 1), rules, anywhere, point)).toBe("toggled");
    expect(grid.applyTap(tile(3, 3), rules, anywhere, point)).toBe("toggled");
    // From code the limit does not hold.
    grid.select([tile(7, 7), tile(8, 8)]);
    expect(grid.selectedCount).toBe(4);
  });

  test("a tap outside the selectable area is reported and goes on as a tap on the map", () => {
    const grid = new ImmersiveMapTileGridController();
    const watch = watched(grid);
    const inside = ImmersiveMapTileID.containing(anywhere, 15);
    const rules = { ...free, selectableBounds: ImmersiveMapTileID.bounds(inside) };
    expect(grid.applyTap(tile(inside.x + 1, inside.y), rules, anywhere, point)).toBe("passed");
    expect(watch.rejections[0]!.reason).toEqual({ kind: "outsideSelectableBounds" });
    expect(grid.applyTap(inside, rules, anywhere, point)).toBe("toggled");
  });

  test("one tile at a time: a tap on another tile moves the selection", () => {
    const grid = new ImmersiveMapTileGridController();
    const watch = watched(grid);
    const rules = { ...free, mode: "single", limit: 1 } as const;
    grid.applyTap(tile(1, 1), rules, anywhere, point);
    expect(grid.applyTap(tile(2, 2), rules, anywhere, point)).toBe("toggled");
    expect(grid.selectedTiles.map(ImmersiveMapTileID.key)).toEqual(["15/2/2"]);
    expect(watch.changes[1]!.removed.map(ImmersiveMapTileID.key)).toEqual(["15/1/1"]);
    expect(watch.rejections).toEqual([]);
    grid.applyTap(tile(2, 2), rules, anywhere, point);
    expect(grid.selectedTiles).toEqual([]);
  });

  test("the texts are asked again when the provider or what it answers changes", () => {
    const grid = new ImmersiveMapTileGridController();
    const watch = watched(grid);
    grid.labelProvider = (t) => `tile ${t.x}`;
    grid.reloadLabels();
    expect(grid.labelRevision).toBe(2);
    expect(watch.frames()).toBe(2);
    expect(TileGridFrame.text(tile(7, 8), "zxy", grid.labelProvider)).toBe("tile 7");
    expect(TileGridFrame.text(tile(7, 8), "zxy", () => "")).toBeUndefined();
    expect(TileGridFrame.text(tile(7, 8), "zxy", null)).toBe("15/7/8");
    expect(TileGridFrame.text(tile(7, 8), "xyz", null)).toBe("7/8/15");
    expect(TileGridFrame.text(tile(7, 8), "hidden", null)).toBeUndefined();
  });

  test("an old map letting go does not detach a new one", () => {
    const grid = new ImmersiveMapTileGridController();
    const old = watched(grid);
    const next = watched(grid);
    grid.clearChangeHandler(old.owner);
    grid.select(tile(1, 1));
    expect(next.frames()).toBe(1);
    grid.clearChangeHandler(next.owner);
    grid.select(tile(2, 2));
    expect(next.frames()).toBe(1);
  });
});

describe("TileGridSelection", () => {
  /** A projection that is never asked: the tests below hand the hit in. */
  const projection = Object.create(GeoScreenProjectionFrameConstants.prototype) as GeoScreenProjectionFrameConstants;
  const snapshot = (frameIndex: number, shows: boolean, gesture: "tap" | "doubleTap" | "secondaryTap" = "tap", limit: number | null = null): TileGridSelectionSnapshot =>
    new TileGridSelectionSnapshot(frameIndex, 800, 600, shows ? projection : undefined, 15, gesture, "multiple", limit, null);

  test("a tile rides in a selection's object id", () => {
    for (const t of [tile(19807, 10243), ImmersiveMapTileID.make(24, 2 ** 24 - 1, 2 ** 24 - 1), ImmersiveMapTileID.make(0, 0, 0)]) {
      expect(TileGridSelection.tile(TileGridSelection.objectID(t))).toEqual(t);
    }
  });

  test("the gesture is the frame's settings', and claimed only while the grid shows tiles for tapping", () => {
    const grid = new ImmersiveMapTileGridController();
    const source: { tileGridController: ImmersiveMapTileGridController | null } = { tileGridController: grid };
    const selection = new TileGridSelection(source);
    expect(selection.tapKind).toBe("single");
    expect(selection.claimsItsTapKind).toBe(false);
    selection.updatePickData(snapshot(3, true, "doubleTap"));
    expect(selection.tapKind).toBe("double");
    expect(selection.claimsItsTapKind).toBe(true);
    // A frame older than the one held is dropped.
    selection.updatePickData(snapshot(2, true, "secondaryTap"));
    expect(selection.tapKind).toBe("double");
    selection.updatePickData(snapshot(4, false, "doubleTap"));
    expect(selection.claimsItsTapKind).toBe(false);
    selection.updatePickData(snapshot(5, true, "secondaryTap"));
    source.tileGridController = null;
    expect(selection.claimsItsTapKind).toBe(false);
    expect(selection.hitTest({ x: 1, y: 1 }, 2)).toBeNull();
  });

  test("a tap on a tile changes the controller's set, never the map's selection, and ends it", () => {
    const grid = new ImmersiveMapTileGridController();
    const selection = new TileGridSelection({ tileGridController: grid });
    selection.updatePickData(snapshot(1, true, "tap", 1));
    const hit = { selection: { kind: "tileGrid", objectID: TileGridSelection.objectID(tile(5, 6)) }, coordinate: anywhere };
    // The grid's hit test needs a projection: the handler is given a feature that answers with the hit.
    const feature: SelectableMapFeature = Object.assign(Object.create(selection) as TileGridSelection, { hitTest: () => hit });
    const pin: SelectableMapFeature = {
      owns: (kind) => kind === "pin",
      updatePickData: () => undefined,
      resetPickData: () => undefined,
      hitTest: () => null,
      contains: () => true,
      setSelected: () => undefined,
      deliverTap: () => false,
    };
    const handler = new ImmersiveMapSelectionHandler({ contentsScale: 2, requestFrame: () => undefined }, [pin, feature]);
    const controller = new ImmersiveMapSelectionController();
    const cleared: string[] = [];
    let backgroundTaps = 0;
    controller.onSelectionCleared = (event) => cleared.push(event.source);
    controller.onMapBackgroundTap = () => backgroundTaps++;
    handler.syncController(controller);
    controller.select({ kind: "pin", objectID: 1 });

    expect(handler.handleMapTap(point)).toBe("consumed");
    expect(grid.isSelected(tile(5, 6))).toBe(true);
    expect(controller.currentSelection()).toBeNull();
    expect(cleared).toEqual(["tap"]);
    expect(backgroundTaps).toBe(0);
    expect(selection.contains()).toBe(false);
    // Past the limit the tap is spent: not a tap on the bare map.
    hit.selection.objectID = TileGridSelection.objectID(tile(7, 7));
    expect(handler.handleMapTap(point)).toBe("consumed");
    expect(grid.selectedCount).toBe(1);
    expect(backgroundTaps).toBe(0);
    // Another gesture than the grid's asks the grid nothing, and lands on nothing.
    expect(handler.handleMapTap(point, "double")).toBe("background");
    expect(handler.isClaimed("double")).toBe(false);
    expect(backgroundTaps).toBe(0);
  });
});
