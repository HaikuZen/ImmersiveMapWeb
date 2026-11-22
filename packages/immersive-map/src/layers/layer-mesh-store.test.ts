// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { geoCoordinate } from "../geo/geo-coordinate.ts";
import { LayerMeshDiskCache } from "./cache/layer-mesh-disk-cache.ts";
import { LayerMeshFile } from "./cache/layer-mesh-file.ts";
import { ImmersiveMapLayer, type ImmersiveMapLayerOptions } from "./immersive-map-layer.ts";
import { type LayerMesh, type LayerMeshFrame, LayerMeshStore } from "./layer-mesh-store.ts";
import { LayerSourceLibrary } from "./sources/layer-source-library.ts";
import { noMeshCache, testLayerJobs } from "./testing/layer-test-jobs.ts";
import type { LayerJobRunner } from "./worker/layer-worker-client.ts";

/** A mesh with no GPU: its chunks read from the file, its destruction counted. */
function fakeFactory(destroyed: string[]) {
  return (key: string, file: ArrayBuffer): LayerMesh | undefined => {
    const contents = LayerMeshFile.decode(file);
    if (contents === undefined) return undefined;
    return { key, chunks: contents.chunks, fillVertices: undefined, fillIndices: undefined, lineSegments: undefined, discs: undefined, gpuBytes: file.byteLength, destroy: () => destroyed.push(key) };
  };
}

/** The jobs, counting the meshes built. */
function countingJobs(): { jobs: LayerJobRunner; builds: () => number } {
  const inner = testLayerJobs();
  let builds = 0;
  return {
    jobs: {
      parse: (document) => inner.parse(document),
      build: (content, styles) => {
        builds++;
        return inner.build(content, styles);
      },
      release: () => inner.release(),
    },
    builds: () => builds,
  };
}

const ring = [geoCoordinate(55.7, 37.5), geoCoordinate(55.7, 37.7), geoCoordinate(55.8, 37.7), geoCoordinate(55.8, 37.5)];

/** Frames of `store` drawing `layers` until none of them is on its way. */
async function settle(store: LayerMeshStore, changes: { next: () => Promise<void> }, layers: ImmersiveMapLayer[], library: LayerSourceLibrary): Promise<LayerMeshFrame> {
  for (;;) {
    const waiting = changes.next();
    const frame = store.meshes(layers, 14, library);
    if (frame.pendingCount === 0) return frame;
    await waiting;
  }
}

function changeSignal(): { fire: () => void; next: () => Promise<void> } {
  let wake: (() => void) | undefined;
  return {
    fire: () => wake?.(),
    next: () => new Promise<void>((resolve) => (wake = resolve)),
  };
}

const layerOf = (options: ImmersiveMapLayerOptions) => ImmersiveMapLayer.make(options);

/** A disk cache that says when it has kept a mesh. */
class RecordingCache extends LayerMeshDiskCache {
  private keptOne: (() => void) | undefined;
  readonly kept = new Promise<void>((resolve) => (this.keptOne = resolve));

  override async store(bytes: ArrayBuffer, name: string): Promise<void> {
    await super.store(bytes, name);
    this.keptOne?.();
  }
}

describe("LayerMeshStore", () => {
  test("a drawn layer is built from its shapes, a changed one draws its last mesh until the new one lands, one let go is destroyed", async () => {
    const destroyed: string[] = [];
    const changes = changeSignal();
    const { jobs, builds } = countingJobs();
    const library = new LayerSourceLibrary(1_000_000, noMeshCache(), jobs);
    library.register("zones", { kind: "shapes", polygons: [{ exterior: ring }], polylines: [], points: [], identity: "v1" });
    const store = new LayerMeshStore(fakeFactory(destroyed), changes.fire);

    const first = store.meshes([layerOf({ source: "zones" })], 14, library);
    expect(first.meshes).toEqual([undefined]);
    expect(first.pendingCount).toBe(1);
    const built = await settle(store, changes, [layerOf({ source: "zones" })], library);
    const mesh = built.meshes[0]!;
    expect(mesh.chunks.length).toBe(1);
    expect(builds()).toBe(1);
    // Built, the source's shapes are let go: a drawn layer needs its mesh alone.
    expect(library.isLoaded("zones")).toBe(false);

    // Hidden or out of its zooms, a layer keeps its mesh and asks for nothing.
    const hidden = store.meshes([layerOf({ source: "zones", isVisible: false })], 14, library);
    expect(hidden.meshes[0]).toBe(mesh);
    expect(hidden.pendingCount).toBe(0);

    const restyled = layerOf({ source: "zones", polygonStyle: { strokeWidthPoints: 9 } });
    const changing = store.meshes([restyled], 14, library);
    expect(changing.meshes[0]).toBe(mesh);
    expect(changing.pendingCount).toBe(1);
    const rebuilt = await settle(store, changes, [restyled], library);
    expect(rebuilt.meshes[0]).not.toBe(mesh);
    expect(destroyed).toEqual([mesh.key]);

    store.meshes([], 14, library);
    expect(destroyed.length).toBe(2);
    expect(store.meshCount).toBe(0);
    store.destroy();
  });

  test("a layer whose source is not registered draws nothing", () => {
    const store = new LayerMeshStore(fakeFactory([]), () => undefined);
    const library = new LayerSourceLibrary(1_000_000, noMeshCache(), testLayerJobs());
    const frame = store.meshes([layerOf({ source: "nothing" })], 14, library);
    expect(frame.meshes).toEqual([undefined]);
    expect(frame.pendingCount).toBe(0);
  });

  test("a layer prepared before is loaded from the disk, its mesh not built again", async () => {
    const database = "layer-mesh-store-test";
    const first = countingJobs();
    const changes = changeSignal();
    const layers = [layerOf({ source: "zones" })];
    const shapes = { kind: "shapes", polygons: [{ exterior: ring }], polylines: [], points: [], identity: "v1" } as const;

    const cache = new RecordingCache(1_000_000, database);
    const library = new LayerSourceLibrary(1_000_000, cache, first.jobs);
    library.register("zones", shapes);
    const store = new LayerMeshStore(fakeFactory([]), changes.fire);
    await settle(store, changes, layers, library);
    expect(first.builds()).toBe(1);
    // The mesh is written in the background.
    await cache.kept;
    expect((await cache.entries()).length).toBe(1);
    store.destroy();

    // Another session: the same data under the same identity.
    const second = countingJobs();
    const nextLibrary = new LayerSourceLibrary(1_000_000, new LayerMeshDiskCache(1_000_000, database), second.jobs);
    nextLibrary.register("zones", shapes);
    const nextStore = new LayerMeshStore(fakeFactory([]), changes.fire);
    const restored = await settle(nextStore, changes, layers, nextLibrary);
    expect(restored.meshes[0]?.chunks.length).toBe(1);
    expect(second.builds()).toBe(0);
    expect(nextLibrary.isLoaded("zones")).toBe(false);
    nextStore.destroy();
  });
});
