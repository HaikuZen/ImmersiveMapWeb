// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { SceneModelMeshStore, type SceneModelStoreMesh } from "./scene-model-mesh-store.ts";

/**
 * The scene models' mesh store (the Swift `SceneModelMeshStore` policy) and
 * the pending count the frame reports from it (the CPU part of Swift
 * `SceneModelPendingMeshDiagnosticsTests`): a source loads once whatever
 * number of models share it, the frame that starts a load still waits for
 * it, and a failed load is tried again after a cooldown, a bounded number
 * of times.
 */

class FakeMesh implements SceneModelStoreMesh {
  destroyed = false;
  constructor(readonly costInBytes = 10) {}
  destroy(): void {
    this.destroyed = true;
  }
}

function makeStore(load: (source: string) => Promise<FakeMesh>, now: () => number = () => 0) {
  let count = 0;
  const waiters: { target: number; resolve: () => void }[] = [];
  const scheduled: number[] = [];
  const store = new SceneModelMeshStore<string, FakeMesh>({
    load,
    invalidate: () => {
      count++;
      for (const w of waiters.filter((w) => w.target <= count)) w.resolve();
    },
    now,
    schedule: (seconds) => scheduled.push(seconds),
    warn: () => undefined,
  });
  const invalidations = (target: number) => (target <= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ target, resolve })));
  /** Lets the rejections of the fake loads run their handlers. */
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return { store, invalidations, scheduled, settle };
}

const sources = (...keys: string[]) => new Map(keys.map((key) => [key, key]));

describe("SceneModelMeshStore", () => {
  it("reports the frame that starts a load as waiting, and the count drops once the mesh arrives", async () => {
    const { store, invalidations } = makeStore(() => Promise.resolve(new FakeMesh()));
    const wanted = sources("cube.obj");
    // A scene with no models is waiting for nothing.
    expect(store.requestMeshes(new Map()).size).toBe(0);
    // The frame that first asks for the mesh cannot already have it.
    expect(wanted.size - store.requestMeshes(wanted).size).toBe(1);
    await invalidations(1);
    expect(wanted.size - store.requestMeshes(wanted).size).toBe(0);
  });

  it("loads a source once, whatever number of frames ask", async () => {
    let loads = 0;
    const { store, invalidations } = makeStore(() => {
      loads++;
      return Promise.resolve(new FakeMesh());
    });
    store.requestMeshes(sources("a"));
    store.requestMeshes(sources("a"));
    await invalidations(1);
    expect(store.requestMeshes(sources("a")).size).toBe(1);
    expect(loads).toBe(1);
  });

  it("tries a failed load again after a growing cooldown, three times at most", async () => {
    let clock = 0;
    let loads = 0;
    const { store, scheduled, settle } = makeStore(
      () => {
        loads++;
        return Promise.reject(new Error("unreadable"));
      },
      () => clock,
    );
    for (let attempt = 1; attempt <= 5; attempt++) {
      store.requestMeshes(sources("broken.glb"));
      await settle();
      clock += 100;
    }
    expect(loads).toBe(SceneModelMeshStore.maxLoadAttempts);
    expect(store.failureAttempts("broken.glb")).toBe(3);
    // The cooldowns of the first two failures ask for a frame, the last gives up.
    expect(scheduled).toEqual([5, 10]);
  });

  it("releases the meshes no model references on a memory warning", async () => {
    const meshes = new Map<string, FakeMesh>();
    const { store, invalidations } = makeStore((source) => {
      const mesh = new FakeMesh();
      meshes.set(source, mesh);
      return Promise.resolve(mesh);
    });
    store.requestMeshes(sources("a", "b"));
    await invalidations(2);
    store.requestMeshes(sources("a"));
    store.handleMemoryWarning();
    expect(meshes.get("b")!.destroyed).toBe(true);
    expect(meshes.get("a")!.destroyed).toBe(false);
  });
});
