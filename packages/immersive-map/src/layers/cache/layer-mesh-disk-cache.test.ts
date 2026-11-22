// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { ImmersiveMapLayer, layerStyleValues } from "../immersive-map-layer.ts";
import type { LayerSourceIdentity } from "../sources/layer-source-data.ts";
import { LayerMeshDiskCache } from "./layer-mesh-disk-cache.ts";

let counter = 0;
const styles = (options: Parameters<typeof ImmersiveMapLayer.make>[0] = { source: "zones" }) => layerStyleValues(ImmersiveMapLayer.make(options));
const url = (identity?: string): LayerSourceIdentity => ({ kind: "url", url: "https://example.invalid/zones.geojson", identity });

/** A cache over a database of its own, the server answering from `validators` and the clock from `clock`. */
function cacheOf(limitBytes: number, validators: Map<string, string> = new Map(), clock = { t: 1000 }) {
  return { cache: new LayerMeshDiskCache(limitBytes, `layer-meshes-test-${counter++}`, (u) => Promise.resolve(validators.get(u)), () => clock.t), validators, clock };
}

describe("LayerMeshDiskCache", () => {
  test("an entry of a URL goes by what the server says of it and by its styles", async () => {
    const { cache, validators } = cacheOf(1_000_000, new Map([["https://example.invalid/zones.geojson", '"one"']]));
    const name = (await cache.entryName(url(), "zones", styles()))!;
    expect(name).toBeDefined();
    // The same document registered again in another session is the same entry.
    expect(await cache.entryName(url(), "zones", styles())).toBe(name);
    expect(await cache.entryName(url(), "zones", styles({ source: "zones", polygonStyle: { strokeWidthPoints: 7 } }))).not.toBe(name);
    // A changed document is another entry, once the server is asked again (a new session).
    validators.set("https://example.invalid/zones.geojson", '"two"');
    const { cache: nextSession } = cacheOf(1_000_000, validators);
    expect(await nextSession.entryName(url(), "zones", styles())).not.toBe(name);
    // A document the server says nothing of is not kept.
    expect(await cache.entryName({ kind: "url", url: "https://example.invalid/missing.geojson", identity: undefined }, "zones", styles())).toBeUndefined();
    // The app's identity of a URL is used as it is, the server not asked.
    expect(await cache.entryName(url("v1"), "zones", styles())).not.toBe(name);
    expect(await cache.entryName({ kind: "url", url: "https://example.invalid/missing.geojson", identity: "v1" }, "zones", styles())).toBeDefined();
  });

  test("an entry of data in memory goes by the identity it was given", async () => {
    const { cache } = cacheOf(1_000_000);
    const name = await cache.entryName({ kind: "named", name: "v1" }, "zones", styles());
    expect(await cache.entryName({ kind: "named", name: "v1" }, "zones", styles())).toBe(name);
    expect(await cache.entryName({ kind: "named", name: "v2" }, "zones", styles())).not.toBe(name);
    // Two sources may use the same identity.
    expect(await cache.entryName({ kind: "named", name: "v1" }, "parks", styles({ source: "parks" }))).not.toBe(name);
  });

  test("a stored entry is found and a removed one is not", async () => {
    const { cache } = cacheOf(1_000_000);
    expect(await cache.get("a")).toBeUndefined();
    await cache.store(new Uint8Array(100).fill(1).buffer, "a");
    expect(new Uint8Array((await cache.get("a"))!)).toEqual(new Uint8Array(100).fill(1));
    await cache.remove("a");
    expect(await cache.get("a")).toBeUndefined();
  });

  test("over the limit the entry used longest ago is deleted", async () => {
    const { cache, clock } = cacheOf(250);
    await cache.store(new ArrayBuffer(100), "old");
    clock.t += 1000;
    await cache.store(new ArrayBuffer(100), "new");
    clock.t += 1000;
    // Reading the old entry makes it the newest.
    await cache.get("old");
    clock.t += 1000;
    await cache.store(new ArrayBuffer(100), "newest");
    expect((await cache.entries()).map((e) => e.name).sort()).toEqual(["newest", "old"]);
  });

  test("a cache with no room keeps nothing", async () => {
    const off = cacheOf(0).cache;
    await off.store(new ArrayBuffer(10), "a");
    expect(off.isEnabled).toBe(false);
    expect(await off.entries()).toEqual([]);
    const small = cacheOf(50).cache;
    // A mesh larger than the limit is not kept.
    await small.store(new ArrayBuffer(100), "large");
    expect(await small.entries()).toEqual([]);
  });
});
