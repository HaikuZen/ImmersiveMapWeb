// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { TileArchiveVersion } from "./archive-version.ts";
import { clearPreparedTileDatabase, openPreparedTileDatabase, PreparedTileDiskCache } from "./prepared-tile-cache.ts";

let counter = 0;
async function cache(policy = { byteQuota: 1_000_000, timeToLive: 3600 }, clock = { t: 1000 }) {
  const db = await openPreparedTileDatabase(`test-${counter++}`);
  return { cache: new PreparedTileDiskCache<{ n: number }>(db, "ns", policy, () => clock.t), clock, db };
}

const entry = (bytes: number, n = 1, sourceETag: string | undefined = undefined) => ({ arena: new ArrayBuffer(bytes), meta: { n }, sourceETag });
const tile = (x: number) => ({ z: 14, x, y: 1 });

describe("PreparedTileDiskCache", () => {
  test("the clear on launch empties every namespace and the remembered archive ETag", async () => {
    const name = `test-${counter++}`;
    let db = await openPreparedTileDatabase(name);
    const a = new PreparedTileDiskCache<{ n: number }>(db, "a", { byteQuota: 1_000_000, timeToLive: 3600 });
    const b = new PreparedTileDiskCache<{ n: number }>(db, "b", { byteQuota: 1_000_000, timeToLive: 3600 });
    await a.put(tile(1), entry(10));
    await b.put(tile(2), entry(10));
    await a.rememberArchiveETag("archive", '"x"');
    db.close();
    await clearPreparedTileDatabase(name);
    db = await openPreparedTileDatabase(name);
    const reopened = new PreparedTileDiskCache<{ n: number }>(db, "a", { byteQuota: 1_000_000, timeToLive: 3600 });
    expect(await reopened.get(tile(1))).toBeUndefined();
    expect(await new PreparedTileDiskCache<{ n: number }>(db, "b", { byteQuota: 1_000_000, timeToLive: 3600 }).get(tile(2))).toBeUndefined();
    expect(await reopened.rememberedArchiveETag("archive")).toBeUndefined();
  });

  test("a put comes back, a missing tile is a miss", async () => {
    const { cache: c } = await cache();
    await c.put(tile(1), entry(100, 7));
    const hit = await c.get(tile(1));
    expect(hit?.meta.n).toBe(7);
    expect(hit?.arena.byteLength).toBe(100);
    expect(await c.get(tile(2))).toBeUndefined();
  });

  test("an entry of another source ETag is passed over", async () => {
    const { cache: c } = await cache();
    await c.put(tile(1), entry(10, 1, '"a"/5'));
    expect(await c.get(tile(1), '"a"/5')).toBeDefined();
    expect(await c.get(tile(1), '"b"/5')).toBeUndefined();
    expect(await c.get(tile(1))).toBeDefined();
  });

  test("an entry past its time to live is a miss and goes", async () => {
    const { cache: c, clock } = await cache({ byteQuota: 1_000_000, timeToLive: 60 });
    await c.put(tile(1), entry(10));
    clock.t += 61;
    expect(await c.get(tile(1))).toBeUndefined();
    expect((await c.availableTiles()).size).toBe(0);
  });

  test("the quota evicts the least recently used first", async () => {
    const { cache: c, clock } = await cache({ byteQuota: 3 * (1000 + 512), timeToLive: 1e9 });
    await c.put(tile(1), entry(1000));
    clock.t += 10_000;
    await c.put(tile(2), entry(1000));
    clock.t += 10_000;
    // Touch tile 1 so tile 2 is the oldest.
    expect(await c.get(tile(1))).toBeDefined();
    clock.t += 10_000;
    await c.put(tile(3), entry(1000));
    clock.t += 10_000;
    await c.put(tile(4), entry(1000));
    expect(await c.get(tile(2))).toBeUndefined();
    expect(await c.get(tile(1))).toBeDefined();
    expect(await c.totalBytes()).toBeLessThanOrEqual(3 * 1512);
  });

  test("the availability seed lists the namespace's tiles", async () => {
    const { cache: c, db } = await cache();
    await c.put(tile(1), entry(10));
    await c.put(tile(2), entry(10));
    const other = new PreparedTileDiskCache<{ n: number }>(db, "other", { byteQuota: 1e9, timeToLive: 3600 }, () => 1000);
    await other.put(tile(3), entry(10));
    expect([...(await c.availableTiles()).keys()].sort()).toEqual(["14/1/1", "14/2/1"]);
    // With when each was last used, read off the keys alone.
    expect([...(await c.availableTiles()).values()]).toEqual([1000, 1000]);
  });

  test("the archive ETag is remembered", async () => {
    const { cache: c } = await cache();
    expect(await c.rememberedArchiveETag("abc")).toBeUndefined();
    await c.rememberArchiveETag("abc", '"v1"');
    expect(await c.rememberedArchiveETag("abc")).toBe('"v1"');
  });
});

describe("TileArchiveVersion", () => {
  const id = (z: number, x: number, y: number) => z * 1000 + x * 10 + y;

  test("expects the archive's ETag and the tile id, nothing while unknown or unreachable", () => {
    const remembered: (string | undefined)[] = [];
    const version = new TileArchiveVersion(undefined, id, (e) => remembered.push(e));
    expect(version.expectedSourceETag(1, 2, 3)).toBeUndefined();
    version.recordSourceETag('"v1"/1023');
    expect(version.expectedSourceETag(1, 2, 3)).toBe('"v1"/1023');
    expect(remembered).toEqual(['"v1"']);
    version.recordUnreachable();
    expect(version.expectedSourceETag(1, 2, 3)).toBeUndefined();
    version.recordArchiveETag('"v1"');
    expect(remembered).toEqual(['"v1"']);
    version.recordSourceETag("-/5");
    expect(version.expectedSourceETag(1, 2, 3)).toBeUndefined();
    expect(version.beginCheck()).toBe(true);
    expect(version.beginCheck()).toBe(false);
  });
});
