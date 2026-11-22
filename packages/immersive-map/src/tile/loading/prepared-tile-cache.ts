// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The disk cache of prepared tiles: every tile the camera has looked at
 * comes back from here without the network. IndexedDB, by benchmark B12
 * (docs/benchmarks/B12-storage.md): every tile worker reads and writes it at
 * once, and eviction is a key's deletion.
 *
 * An entry is a tile's arena (its GPU bytes, one blob laid out as the
 * renderer binds it) and its CPU metadata, keyed by the cache namespace (the
 * format version and the identity of everything the parse depends on, the
 * Swift `PreparedTileCacheIdentity`) and the tile. An entry remembers the
 * source ETag it was parsed from, so the disk stage passes over the tiles of
 * an older upload of the archive (`TileArchiveVersion`).
 *
 * The policy is the Swift `PreparedTileDiskIOCoordinator`'s: a root-wide byte
 * quota over every namespace, least recently used out first, and a time to
 * live measured from the last access. The access time doubles as the LRU
 * clock, refreshed at most every `min(15 min, ttl / 16)` per entry.
 */

import { type Tile, tileKey } from "../tile.ts";

export interface PreparedTileEntry<Meta> {
  /** The arena bytes. */
  arena: ArrayBuffer;
  /** Structured-cloneable CPU metadata. */
  meta: Meta;
  /** The archive's ETag and the tile id the entry was parsed from, `undefined` for a source without ETags. */
  sourceETag: string | undefined;
}

interface StoredEntry<Meta> extends PreparedTileEntry<Meta> {
  key: string;
  namespace: string;
  tile: string;
  bytes: number;
  accessedAt: number;
}

export interface PreparedTileCachePolicy {
  /** Root-wide byte quota over every namespace. */
  byteQuota: number;
  /** Seconds from the last access after which an entry is a miss. */
  timeToLive: number;
}

const DATABASE = "immersive-map-prepared-tiles";
const VERSION = 1;
const TILES = "tiles";
const STATE = "state";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function openPreparedTileDatabase(name = DATABASE): Promise<IDBDatabase> {
  const open = indexedDB.open(name, VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    const tiles = db.createObjectStore(TILES, { keyPath: "key" });
    tiles.createIndex("accessedAt", "accessedAt");
    tiles.createIndex("namespace", "namespace");
    db.createObjectStore(STATE);
  };
  return request(open);
}

/**
 * Clears every prepared tile and every remembered archive ETag, of every
 * namespace (the settings' `clearDiskCachesOnLaunch`, the Swift cache's
 * `prepare(clearOnLaunch:)` and `TileArchiveVersion(clearsRemembered:)`).
 * Run on the main thread before the tile workers open the database.
 */
export async function clearPreparedTileDatabase(name = DATABASE): Promise<void> {
  const db = await openPreparedTileDatabase(name);
  try {
    const tx = db.transaction([TILES, STATE], "readwrite");
    tx.objectStore(TILES).clear();
    tx.objectStore(STATE).clear();
    await done(tx);
  } finally {
    db.close();
  }
}

export class PreparedTileDiskCache<Meta> {
  /** Seconds. */
  private readonly now: () => number;
  private readonly accessedAt = new Map<string, number>();

  constructor(
    private readonly db: IDBDatabase,
    readonly namespace: string,
    private policy: PreparedTileCachePolicy,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now() / 1000);
  }

  setPolicy(policy: PreparedTileCachePolicy): void {
    this.policy = policy;
  }

  private key(tile: Tile): string {
    return `${this.namespace}|${tileKey(tile)}`;
  }

  private isExpired(accessedAt: number, now: number): boolean {
    return now - accessedAt > this.policy.timeToLive;
  }

  /**
   * The entry of `tile`, or `undefined` for a miss: absent, expired, or of
   * another source ETag than `expectedSourceETag` when one is given.
   */
  async get(tile: Tile, expectedSourceETag?: string): Promise<PreparedTileEntry<Meta> | undefined> {
    const tx = this.db.transaction(TILES, "readonly");
    const stored = (await request(tx.objectStore(TILES).get(this.key(tile)))) as StoredEntry<Meta> | undefined;
    if (!stored) return undefined;
    const now = this.now();
    if (this.isExpired(stored.accessedAt, now)) {
      void this.remove(tile);
      return undefined;
    }
    if (expectedSourceETag !== undefined && stored.sourceETag !== expectedSourceETag) return undefined;
    this.markAccessed(stored, now);
    return { arena: stored.arena, meta: stored.meta, sourceETag: stored.sourceETag };
  }

  /** LRU decisions tolerate coarse access times: a recently refreshed entry is left untouched. */
  private markAccessed(stored: StoredEntry<Meta>, now: number): void {
    const refreshInterval = Math.min(15 * 60, this.policy.timeToLive / 16);
    const last = this.accessedAt.get(stored.key) ?? stored.accessedAt;
    if (now - last < refreshInterval) return;
    this.accessedAt.set(stored.key, now);
    const tx = this.db.transaction(TILES, "readwrite");
    tx.objectStore(TILES).put({ ...stored, accessedAt: now });
  }

  async put(tile: Tile, entry: PreparedTileEntry<Meta>): Promise<void> {
    const key = this.key(tile);
    const now = this.now();
    const stored: StoredEntry<Meta> = {
      ...entry,
      key,
      namespace: this.namespace,
      tile: tileKey(tile),
      bytes: entry.arena.byteLength + 512,
      accessedAt: now,
    };
    const tx = this.db.transaction([TILES, STATE], "readwrite");
    const tiles = tx.objectStore(TILES);
    const state = tx.objectStore(STATE);
    const previous = (await request(tiles.get(key))) as StoredEntry<Meta> | undefined;
    const total = ((await request(state.get("totalBytes"))) as number | undefined) ?? 0;
    tiles.put(stored);
    state.put(total + stored.bytes - (previous?.bytes ?? 0), "totalBytes");
    this.accessedAt.set(key, now);
    await done(tx);
    await this.prune();
  }

  async remove(tile: Tile): Promise<void> {
    const key = this.key(tile);
    const tx = this.db.transaction([TILES, STATE], "readwrite");
    const tiles = tx.objectStore(TILES);
    const state = tx.objectStore(STATE);
    const previous = (await request(tiles.get(key))) as StoredEntry<Meta> | undefined;
    if (previous) {
      const total = ((await request(state.get("totalBytes"))) as number | undefined) ?? 0;
      tiles.delete(key);
      state.put(Math.max(0, total - previous.bytes), "totalBytes");
    }
    this.accessedAt.delete(key);
    await done(tx);
  }

  /** Least recently used out first until the root-wide total fits the quota. */
  async prune(): Promise<void> {
    const tx = this.db.transaction([TILES, STATE], "readwrite");
    const tiles = tx.objectStore(TILES);
    const state = tx.objectStore(STATE);
    let total = ((await request(state.get("totalBytes"))) as number | undefined) ?? 0;
    if (total <= this.policy.byteQuota) {
      await done(tx);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const cursor = tiles.index("accessedAt").openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || total <= this.policy.byteQuota) {
          resolve();
          return;
        }
        const value = c.value as StoredEntry<Meta>;
        total -= value.bytes;
        this.accessedAt.delete(value.key);
        c.delete();
        c.continue();
      };
    });
    state.put(Math.max(0, total), "totalBytes");
    await done(tx);
  }

  /** The tiles of this namespace that are not expired, with their access times: the availability index's seed. */
  async availableTiles(): Promise<Map<string, number>> {
    const tx = this.db.transaction(TILES, "readonly");
    const range = IDBKeyRange.only(this.namespace);
    const entries = new Map<string, number>();
    const now = this.now();
    await new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore(TILES).index("namespace").openCursor(range);
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve();
          return;
        }
        const value = c.value as StoredEntry<Meta>;
        if (!this.isExpired(value.accessedAt, now)) entries.set(value.tile, value.accessedAt);
        c.continue();
      };
    });
    return entries;
  }

  /** Everything gone, every namespace (the settings' clear-on-launch). */
  async clearAll(): Promise<void> {
    const tx = this.db.transaction([TILES, STATE], "readwrite");
    tx.objectStore(TILES).clear();
    tx.objectStore(STATE).clear();
    this.accessedAt.clear();
    await done(tx);
  }

  async totalBytes(): Promise<number> {
    const tx = this.db.transaction(STATE, "readonly");
    return ((await request(tx.objectStore(STATE).get("totalBytes"))) as number | undefined) ?? 0;
  }

  /** The ETag remembered for an archive, so a warm start knows it without a request. */
  async rememberedArchiveETag(sourceRevision: string): Promise<string | undefined> {
    const tx = this.db.transaction(STATE, "readonly");
    return (await request(tx.objectStore(STATE).get(`archive:${sourceRevision}`))) as string | undefined;
  }

  async rememberArchiveETag(sourceRevision: string, etag: string | undefined): Promise<void> {
    const tx = this.db.transaction(STATE, "readwrite");
    if (etag) tx.objectStore(STATE).put(etag, `archive:${sourceRevision}`);
    else tx.objectStore(STATE).delete(`archive:${sourceRevision}`);
    await done(tx);
  }
}
