// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayHUDSnapshotStoreTests`: the versions a
// panel consumes, the reporter's provider between frames, and the one hop a
// burst of loader changes folds into (a microtask here, the main queue in
// Swift).

import { describe, expect, test } from "vitest";
import type { Tile } from "../../tile/tile.ts";
import { DebugOverlayHUDContentRequest, DebugOverlayHUDSnapshotStore } from "./debug-overlay-hud-snapshot-store.ts";
import { TileLoadingStatusReporter, TileLoadingStatusSnapshot } from "./tile-loading-status-reporter.ts";

/** A stand-in for the debug entry's HUD snapshot: the frame's lines and the loader's rows. */
interface HUDSnapshot {
  readonly zoom: string;
  readonly diagnosticsLines: readonly string[];
  readonly status: TileLoadingStatusSnapshot;
}

const replace = (snapshot: HUDSnapshot, status: TileLoadingStatusSnapshot): HUDSnapshot => ({ ...snapshot, status });
const isEqual = (lhs: HUDSnapshot, rhs: HUDSnapshot): boolean =>
  lhs.zoom === rhs.zoom && lhs.diagnosticsLines.join("\n") === rhs.diagnosticsLines.join("\n") && TileLoadingStatusSnapshot.equals(lhs.status, rhs.status);

function makeSnapshot(zoom: string): HUDSnapshot {
  return { zoom, diagnosticsLines: ["frame:1 dt:16.67ms fps:60.0"], status: TileLoadingStatusSnapshot.empty };
}

const tile: Tile = { x: 1, y: 1, z: 4 };

describe("DebugOverlayHUDSnapshotStore", () => {
  test("consumeLatest returns only newly published versions", () => {
    const store = new DebugOverlayHUDSnapshotStore<HUDSnapshot, TileLoadingStatusSnapshot>();
    const snapshot = makeSnapshot("z: 4.62");
    expect(store.consumeLatest(0)).toBeUndefined();
    const firstVersion = store.publish(snapshot);
    const firstValue = store.consumeLatest(0);
    expect(firstValue?.version).toBe(firstVersion);
    expect(firstValue?.snapshot).toBe(snapshot);
    expect(store.consumeLatest(firstVersion)).toBeUndefined();
  });

  test("an undefined snapshot is published as a store version", () => {
    const store = new DebugOverlayHUDSnapshotStore<HUDSnapshot, TileLoadingStatusSnapshot>();
    const version = store.publish(undefined);
    const value = store.consumeLatest(0);
    expect(value?.version).toBe(version);
    expect(value?.snapshot).toBeUndefined();
  });

  test("the attached provider answers between frames until detached", () => {
    const store = new DebugOverlayHUDSnapshotStore<HUDSnapshot, TileLoadingStatusSnapshot>();
    expect(store.currentTileLoadingStatus()).toBeUndefined();
    const reporter = new TileLoadingStatusReporter();
    reporter.recordDemand(1, 1, [tile]);
    reporter.recordLoadScheduled(tile);
    store.attachTileLoadingStatus(() => reporter.snapshot());
    expect(store.currentTileLoadingStatus()?.tiles.map((row) => row.tile)).toEqual([tile]);
    store.attachTileLoadingStatus(undefined);
    expect(store.currentTileLoadingStatus()).toBeUndefined();
  });

  test("replacing the tile list keeps the frame, and nothing moved means no refresh", () => {
    const store = new DebugOverlayHUDSnapshotStore<HUDSnapshot, TileLoadingStatusSnapshot>();
    const snapshot = makeSnapshot("z: 4.62");
    const reporter = new TileLoadingStatusReporter();
    store.attachTileLoadingStatus(() => reporter.snapshot());
    expect(store.refreshedSnapshot(snapshot, replace, isEqual)).toBeUndefined();
    expect(store.refreshedSnapshot(undefined, replace, isEqual), "nothing shown, nothing to refresh").toBeUndefined();

    reporter.recordDemand(1, 1, [tile]);
    reporter.recordLoadScheduled(tile);
    const refreshed = store.refreshedSnapshot(snapshot, replace, isEqual);
    expect(refreshed).toBeDefined();
    expect(refreshed!.zoom).toBe(snapshot.zoom);
    expect(refreshed!.diagnosticsLines).toBe(snapshot.diagnosticsLines);
    expect(refreshed!.status.tiles.map((row) => row.tile)).toEqual([tile]);
    expect(TileLoadingStatusSnapshot.lines(refreshed!.status)).not.toHaveLength(0);
  });

  test("a burst of loader changes reaches the panel once, a microtask later", async () => {
    const store = new DebugOverlayHUDSnapshotStore<HUDSnapshot, TileLoadingStatusSnapshot>();
    let calls = 0;
    store.onTileLoadingStatusChanged = () => (calls += 1);
    store.noteTileLoadingStatusChanged();
    store.noteTileLoadingStatusChanged();
    store.noteTileLoadingStatusChanged();
    expect(calls, "nothing runs inside the loader's own call").toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    store.noteTileLoadingStatusChanged();
    await Promise.resolve();
    expect(calls, "the next burst gets its own hop").toBe(2);
  });

  test("the content request is a bit set of the panel's tabs", () => {
    const store = new DebugOverlayHUDSnapshotStore<HUDSnapshot, TileLoadingStatusSnapshot>();
    expect(store.requestedContent).toBe(DebugOverlayHUDContentRequest.all);
    store.requestedContent = DebugOverlayHUDContentRequest.tiles;
    expect(DebugOverlayHUDContentRequest.contains(store.requestedContent, DebugOverlayHUDContentRequest.tiles)).toBe(true);
    expect(DebugOverlayHUDContentRequest.contains(store.requestedContent, DebugOverlayHUDContentRequest.stats)).toBe(false);
    expect(DebugOverlayHUDContentRequest.contains(DebugOverlayHUDContentRequest.all, DebugOverlayHUDContentRequest.stats | DebugOverlayHUDContentRequest.relief)).toBe(true);
  });
});
