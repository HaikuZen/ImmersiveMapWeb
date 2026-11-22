// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

// B12 in a worker, where the tile cache will live: write and read prepared
// tiles through OPFS (sync access handles, and async File reads), IndexedDB
// and the Cache API. A fresh worker per read phase stands in for a cold
// start of the store (opening it, the first lookups).

export {};
declare const self: DedicatedWorkerGlobalScope;

const DB = "bench-tiles";
const CACHE = "bench-tiles";
const now = () => performance.now();

/** The packed OPFS layout: one file, one open sync handle, an index of offsets (kept in a side file). */
let packed: { handle: FileSystemSyncAccessHandle; index: [number, number][] } | undefined;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tiles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const done = (r: IDBRequest | IDBTransaction) =>
  new Promise<any>((resolve, reject) => {
    if (r instanceof IDBTransaction) {
      r.oncomplete = () => resolve(undefined);
      r.onerror = () => reject(r.error);
    } else {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }
  });

async function clear() {
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as any).keys()) await root.removeEntry(name, { recursive: true });
  await caches.delete(CACHE);
  await new Promise((r) => {
    const q = indexedDB.deleteDatabase(DB);
    q.onsuccess = q.onerror = q.onblocked = r;
  });
}

async function write(store: string, tiles: ArrayBuffer[]): Promise<number[]> {
  const times: number[] = [];
  if (store === "opfs-packed") {
    const root = await navigator.storage.getDirectory();
    const handle = await (await root.getFileHandle("packed", { create: true })).createSyncAccessHandle();
    const index: [number, number][] = [];
    let end = 0;
    for (let k = 0; k < tiles.length; k++) {
      const start = now();
      const bytes = new Uint8Array(tiles[k]!);
      handle.write(bytes, { at: end });
      index.push([end, bytes.length]);
      end += bytes.length;
      handle.flush();
      times.push(now() - start);
    }
    handle.close();
    const indexHandle = await (await root.getFileHandle("packed.index", { create: true })).createSyncAccessHandle();
    indexHandle.write(new TextEncoder().encode(JSON.stringify(index)), { at: 0 });
    indexHandle.close();
  } else if (store === "opfs-sync") {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("tiles", { create: true });
    for (let k = 0; k < tiles.length; k++) {
      const start = now();
      const handle = await (await dir.getFileHandle(`${k}`, { create: true })).createSyncAccessHandle();
      handle.truncate(0);
      handle.write(new Uint8Array(tiles[k]!), { at: 0 });
      handle.flush();
      handle.close();
      times.push(now() - start);
    }
  } else if (store === "idb") {
    const db = await idb();
    for (let k = 0; k < tiles.length; k++) {
      const start = now();
      const tx = db.transaction("tiles", "readwrite");
      tx.objectStore("tiles").put(tiles[k], k);
      await done(tx);
      times.push(now() - start);
    }
    db.close();
  } else {
    const cache = await caches.open(CACHE);
    for (let k = 0; k < tiles.length; k++) {
      const start = now();
      await cache.put(`/tile/${k}`, new Response(tiles[k]));
      times.push(now() - start);
    }
  }
  return times;
}

async function read(store: string, count: number): Promise<{ open: number; times: number[]; bytes: number }> {
  const times: number[] = [];
  let bytes = 0;
  const openStart = now();
  if (store === "opfs-packed") {
    if (!packed) {
      const root = await navigator.storage.getDirectory();
      const indexHandle = await (await root.getFileHandle("packed.index")).createSyncAccessHandle();
      const raw = new Uint8Array(indexHandle.getSize());
      indexHandle.read(raw, { at: 0 });
      indexHandle.close();
      packed = { handle: await (await root.getFileHandle("packed")).createSyncAccessHandle(), index: JSON.parse(new TextDecoder().decode(raw)) };
    }
    const open = now() - openStart;
    for (let k = 0; k < count; k++) {
      const start = now();
      const [offset, length] = packed.index[k]!;
      const out = new Uint8Array(length);
      packed.handle.read(out, { at: offset });
      bytes += out.byteLength;
      times.push(now() - start);
    }
    return { open, times, bytes };
  }
  if (store === "opfs-sync" || store === "opfs-file") {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("tiles");
    const open = now() - openStart;
    for (let k = 0; k < count; k++) {
      const start = now();
      const fileHandle = await dir.getFileHandle(`${k}`);
      let data: ArrayBuffer;
      if (store === "opfs-sync") {
        const handle = await fileHandle.createSyncAccessHandle();
        const out = new Uint8Array(handle.getSize());
        handle.read(out, { at: 0 });
        handle.close();
        data = out.buffer;
      } else {
        data = await (await fileHandle.getFile()).arrayBuffer();
      }
      bytes += data.byteLength;
      times.push(now() - start);
    }
    return { open, times, bytes };
  }
  if (store === "idb") {
    const db = await idb();
    const open = now() - openStart;
    for (let k = 0; k < count; k++) {
      const start = now();
      const data: ArrayBuffer = await done(db.transaction("tiles").objectStore("tiles").get(k));
      bytes += data.byteLength;
      times.push(now() - start);
    }
    db.close();
    return { open, times, bytes };
  }
  const cache = await caches.open(CACHE);
  const open = now() - openStart;
  for (let k = 0; k < count; k++) {
    const start = now();
    const response = await cache.match(`/tile/${k}`);
    const data = await response!.arrayBuffer();
    bytes += data.byteLength;
    times.push(now() - start);
  }
  return { open, times, bytes };
}

self.onmessage = async (event: MessageEvent) => {
  const m = event.data;
  try {
    if (m.type === "clear") self.postMessage(await clear());
    else if (m.type === "write") self.postMessage(await write(m.store, m.tiles));
    else self.postMessage(await read(m.store, m.count));
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
