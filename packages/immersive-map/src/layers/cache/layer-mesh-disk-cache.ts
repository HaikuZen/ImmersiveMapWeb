// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { LayerSourceIdentity } from "../sources/layer-source-data.ts";
import { LayerMeshFile } from "./layer-mesh-file.ts";

/** What the build bakes into every mesh besides its source and styles: a change to it is another entry. Mirrors crates/layer-mesh. */
const BUILD_SIGNATURE = `${LayerMeshFile.version}|6|${1 / 256}`;

const DATABASE = "immersive-map-layer-meshes";
const VERSION = 1;
/** The meshes' bytes by entry name. */
const MESHES = "meshes";
/** Each entry's size and last use, by entry name: the trimming reads these alone. */
const ENTRIES = "entries";

interface EntryRecord {
  readonly name: string;
  readonly size: number;
  readonly usedAt: number;
}

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

function openDatabase(name: string): Promise<IDBDatabase> {
  const open = indexedDB.open(name, VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore(MESHES);
    db.createObjectStore(ENTRIES, { keyPath: "name" }).createIndex("usedAt", "usedAt");
  };
  return request(open);
}

/**
 * What the server says of a document at a URL, as a file's size and date
 * say of it on disk: its ETag, or its date and its length. `undefined` when
 * the server says none of it or cannot be asked: such a document is not
 * kept on disk, as a file that cannot be looked at is not in Swift.
 */
export async function probeDocumentValidator(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return undefined;
    const etag = response.headers.get("ETag");
    if (etag) return `etag:${etag}`;
    const modified = response.headers.get("Last-Modified");
    const length = response.headers.get("Content-Length");
    return modified ? `modified:${modified}|length:${length ?? ""}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The meshes of the layers, kept on disk as the GPU takes them
 * (`LayerMeshFile`), the Swift `LayerMeshDiskCache` on IndexedDB (decision
 * B12). A layer is built from its source once: afterwards its mesh is
 * loaded from here, and the source is neither fetched nor read. A mesh goes
 * by what it was made of: its source's identity (`LayerSourceIdentity`: a
 * URL with the app's identity or what the server says of it, or the
 * identity the app gave to data it handed over, under the source's name),
 * the styles baked into it, and the format's version, so a changed source or
 * a changed style is another entry. The data itself is never hashed. The
 * entries used least recently are deleted over `limitBytes`.
 */
export class LayerMeshDiskCache {
  readonly limitBytes: number;
  private database: Promise<IDBDatabase> | undefined;
  private readonly validators = new Map<string, Promise<string | undefined>>();

  /** A limit of zero keeps nothing. */
  constructor(
    limitBytes: number,
    private readonly databaseName = DATABASE,
    private readonly probe: (url: string) => Promise<string | undefined> = probeDocumentValidator,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.limitBytes = Math.max(limitBytes, 0);
  }

  get isEnabled(): boolean {
    return this.limitBytes > 0 && typeof indexedDB !== "undefined";
  }

  /**
   * The entry's name for a layer of `source` (the name it is registered
   * under) whose data `identity` names, drawn in `styles` (the layer's
   * `layerStyleValues`), `undefined` for a URL the server says nothing of.
   * The name is made of the identity and the styles, never of the data. A
   * URL the app gave no identity is asked about once a session.
   */
  async entryName(identity: LayerSourceIdentity, source: string, styles: ArrayLike<number>): Promise<string | undefined> {
    let what: string;
    if (identity.kind === "url") {
      if (identity.identity !== undefined) {
        what = `url\u0000${identity.url}\u0000app\u0000${identity.identity}`;
      } else {
        let validator = this.validators.get(identity.url);
        if (!validator) {
          validator = this.probe(identity.url);
          this.validators.set(identity.url, validator);
        }
        const value = await validator;
        if (value === undefined) {
          // Asked again next time: the server may answer then.
          this.validators.delete(identity.url);
          return undefined;
        }
        what = `url\u0000${identity.url}\u0000server\u0000${value}`;
      }
    } else {
      // A separator no name holds, so "a" under "bc" is not "ab" under "c".
      what = `named\u0000${source}\u0000${identity.name}`;
    }
    return `${BUILD_SIGNATURE}\u0000${what}\u0000${Array.from(styles, (v) => Math.fround(v)).join(",")}`;
  }

  /** The entry's bytes when the cache holds it, marked as used now. */
  async get(name: string): Promise<ArrayBuffer | undefined> {
    if (!this.isEnabled) return undefined;
    const db = await this.db();
    const tx = db.transaction([MESHES, ENTRIES], "readwrite");
    const bytes = (await request(tx.objectStore(MESHES).get(name))) as ArrayBuffer | undefined;
    if (bytes !== undefined) tx.objectStore(ENTRIES).put({ name, size: bytes.byteLength, usedAt: this.now() } satisfies EntryRecord);
    await done(tx);
    return bytes;
  }

  /**
   * Keeps `bytes` under `name`, then deletes the entries used least
   * recently while the cache is over its limit. A mesh larger than the limit
   * is not kept.
   */
  async store(bytes: ArrayBuffer, name: string): Promise<void> {
    if (!this.isEnabled || bytes.byteLength > this.limitBytes) return;
    const db = await this.db();
    const tx = db.transaction([MESHES, ENTRIES], "readwrite");
    tx.objectStore(MESHES).put(bytes, name);
    tx.objectStore(ENTRIES).put({ name, size: bytes.byteLength, usedAt: this.now() } satisfies EntryRecord);
    await done(tx);
    await this.trim();
  }

  async remove(name: string): Promise<void> {
    if (!this.isEnabled) return;
    const db = await this.db();
    const tx = db.transaction([MESHES, ENTRIES], "readwrite");
    tx.objectStore(MESHES).delete(name);
    tx.objectStore(ENTRIES).delete(name);
    await done(tx);
  }

  /** The entries, the one used longest ago first. */
  async entries(): Promise<EntryRecord[]> {
    if (!this.isEnabled) return [];
    const db = await this.db();
    const tx = db.transaction(ENTRIES, "readonly");
    return (await request(tx.objectStore(ENTRIES).index("usedAt").getAll())) as EntryRecord[];
  }

  /** Closes the database. A later call opens it again. */
  close(): void {
    const database = this.database;
    this.database = undefined;
    void database?.then((db) => db.close()).catch(() => undefined);
  }

  private db(): Promise<IDBDatabase> {
    this.database ??= openDatabase(this.databaseName);
    return this.database;
  }

  private async trim(): Promise<void> {
    const entries = await this.entries();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.limitBytes) return;
    const db = await this.db();
    const tx = db.transaction([MESHES, ENTRIES], "readwrite");
    for (const entry of entries) {
      if (total <= this.limitBytes) break;
      tx.objectStore(MESHES).delete(entry.name);
      tx.objectStore(ENTRIES).delete(entry.name);
      total -= entry.size;
    }
    await done(tx);
  }
}
