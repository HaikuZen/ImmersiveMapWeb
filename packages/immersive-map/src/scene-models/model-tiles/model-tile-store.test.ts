// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { Tile } from "../../tile/tile.ts";
import { ModelTileLoadFailure, type ModelTileLoad, ModelTileStore, type ModelTileStoreMesh } from "./model-tile-store.ts";

/**
 * Swift `ModelTileStoreTests` (the policy part): a wanted tile loads and is
 * answered on a later frame, an empty tile is asked for once, a failed one
 * again after a pause, and the tiles the camera has left go when the budget
 * is passed. The loads are promises the test settles, and every check waits
 * for the store's own `invalidate`, never for time.
 */

const tileA: Tile = { x: 9904, y: 5121, z: 14 };
const tileB: Tile = { x: 9905, y: 5121, z: 14 };

class FakeMesh implements ModelTileStoreMesh {
  destroyed = false;
  constructor(
    readonly tile: Tile,
    readonly costInBytes = 100,
  ) {}
  destroy(): void {
    this.destroyed = true;
  }
}

/** A store whose invalidations a test can wait for, one by one. */
function makeStore(load: ModelTileLoad<FakeMesh>, options: { costLimitBytes?: number; now?: () => number } = {}) {
  let count = 0;
  const waiters: { target: number; resolve: () => void }[] = [];
  const scheduled: { seconds: number; body: () => void }[] = [];
  const warnings: string[] = [];
  const store = new ModelTileStore<FakeMesh>({
    costLimitBytes: options.costLimitBytes ?? 1 << 20,
    load,
    invalidate: () => {
      count++;
      for (const waiter of waiters.filter((w) => w.target <= count)) waiter.resolve();
    },
    ...(options.now ? { now: options.now } : {}),
    schedule: (seconds, body) => scheduled.push({ seconds, body }),
    warn: (message) => warnings.push(message),
  });
  const invalidations = (target: number) =>
    target <= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ target, resolve }));
  return { store, invalidations, scheduled, warnings };
}

const meshLoad: ModelTileLoad<FakeMesh> = (tile) => Promise.resolve({ kind: "mesh", mesh: new FakeMesh(tile) });

describe("ModelTileStore", () => {
  it("loads a wanted tile and answers it on a later frame", async () => {
    const { store, invalidations } = makeStore(meshLoad);
    const first = store.meshes([tileA]);
    expect(first.ready).toEqual([]);
    expect(first.pending).toEqual([tileA]);
    await invalidations(1);
    const second = store.meshes([tileA]);
    expect(second.ready.map((m) => m.tile)).toEqual([tileA]);
    expect(second.pending).toEqual([]);
  });

  it("asks for a tile the archive does not hold once", async () => {
    let loads = 0;
    const { store, invalidations } = makeStore(() => {
      loads++;
      return Promise.resolve({ kind: "missing" });
    });
    store.meshes([tileA]);
    await invalidations(1);
    for (let i = 0; i < 3; i++) expect(store.meshes([tileA])).toEqual({ ready: [], pending: [] });
    expect(loads).toBe(1);
  });

  it("releases a tile left behind past the budget, never a wanted one", async () => {
    const { store, invalidations } = makeStore(meshLoad, { costLimitBytes: 1 });
    store.meshes([tileA, tileB]);
    await invalidations(2);
    // Both are wanted, so both stay over the budget.
    const both = store.meshes([tileA, tileB]).ready;
    expect(both.length).toBe(2);
    store.meshes([tileB]);
    store.evict();
    expect([...store.residentTiles]).toEqual(["14/9905/5121"]);
    expect(both[0]!.destroyed).toBe(true);
    expect(both[1]!.destroyed).toBe(false);
    expect(store.meshes([tileB]).ready.length).toBe(1);
  });

  it("releases what the last frame did not want on a memory warning", async () => {
    const { store, invalidations } = makeStore(meshLoad, { costLimitBytes: 1 << 30 });
    store.meshes([tileA, tileB]);
    await invalidations(2);
    store.meshes([tileA]);
    store.evict();
    // Inside the budget nothing goes.
    expect(store.residentTiles.size).toBe(2);
    store.handleMemoryWarning();
    expect([...store.residentTiles]).toEqual(["14/9904/5121"]);
  });

  it("asks for a failed tile again after a pause", async () => {
    let loads = 0;
    let clock = 1000;
    const { store, invalidations, scheduled } = makeStore(
      (tile) => {
        loads++;
        if (loads === 1) return Promise.reject(new ModelTileLoadFailure("unavailable", "offline"));
        return Promise.resolve({ kind: "mesh", mesh: new FakeMesh(tile) });
      },
      { now: () => clock },
    );
    store.meshes([tileA]);
    await invalidations(1);
    const duringPause = store.meshes([tileA]);
    expect(duringPause.ready).toEqual([]);
    // A tile waiting out its pause is not on its way.
    expect(duringPause.pending).toEqual([]);
    expect(loads).toBe(1);
    // The end of the pause asks for a frame.
    expect(scheduled.map((s) => s.seconds)).toEqual([ModelTileStore.retryBaseDelay]);
    clock += ModelTileStore.retryBaseDelay + 1;
    expect(store.meshes([tileA]).pending).toEqual([tileA]);
    await invalidations(2);
    expect(store.meshes([tileA]).ready.length).toBe(1);
    expect(loads).toBe(2);
  });

  it("lengthens the pause with every failure, up to the maximum", async () => {
    let clock = 0;
    const { store, invalidations, scheduled } = makeStore(() => Promise.reject(new ModelTileLoadFailure("unavailable", "offline")), { now: () => clock });
    for (let attempt = 1; attempt <= 6; attempt++) {
      store.meshes([tileA]);
      await invalidations(attempt);
      clock += ModelTileStore.retryMaximumDelay + 1;
    }
    expect(scheduled.map((s) => s.seconds)).toEqual([5, 10, 20, 40, 60, 60]);
  });

  it("does not ask again for a tile that cannot be read, and reports it", async () => {
    let loads = 0;
    const { store, invalidations, warnings } = makeStore(() => {
      loads++;
      return Promise.reject(new ModelTileLoadFailure("unreadable", "badMagic"));
    });
    store.meshes([tileA]);
    await invalidations(1);
    expect(store.meshes([tileA])).toEqual({ ready: [], pending: [] });
    expect(loads).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("14/9904/5121");
  });

  it("loads no more than the limit at once, in the order the frame names them", async () => {
    const started: Tile[] = [];
    const gates: (() => void)[] = [];
    const { store, invalidations } = makeStore((tile) => {
      started.push(tile);
      return new Promise((resolve) => gates.push(() => resolve({ kind: "missing" })));
    });
    const wanted = Array.from({ length: 6 }, (_, i) => ({ x: 9900 + i, y: 5121, z: 14 }));
    expect(store.meshes(wanted).pending.length).toBe(6);
    // Asking again starts nothing more.
    expect(store.meshes(wanted).pending.length).toBe(6);
    expect(started).toEqual(wanted.slice(0, ModelTileStore.maximumConcurrentLoads));
    for (const open of gates.splice(0)) open();
    await invalidations(ModelTileStore.maximumConcurrentLoads);
    // The two that waited start now.
    expect(store.meshes(wanted).pending.length).toBe(2);
    for (const open of gates.splice(0)) open();
    await invalidations(6);
    expect(store.meshes(wanted).pending.length).toBe(0);
    expect(started).toEqual(wanted);
  });

  it("destroys a mesh that arrives after the store was destroyed", async () => {
    let open: (() => void) | undefined;
    const mesh = new FakeMesh(tileA);
    const { store } = makeStore(() => new Promise((resolve) => (open = () => resolve({ kind: "mesh", mesh }))));
    store.meshes([tileA]);
    store.destroy();
    open!();
    await Promise.resolve();
    await Promise.resolve();
    expect(mesh.destroyed).toBe(true);
  });
});
