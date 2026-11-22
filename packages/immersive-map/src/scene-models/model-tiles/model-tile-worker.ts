// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

/**
 * The model tile worker, the Swift `ModelTileSource` and the decoding half
 * of `ModelTileStore`'s load: a tile comes from the disk cache, or from the
 * model archive and is then kept on disk, and is decoded and checked in the
 * worker's own Wasm (crates/model-wasm, the port of `ModelTileFormat`).
 * What goes back is the tile as the GPU takes it: its vertex and index
 * blocks and its texture, the ASTC blocks as stored, or decoded to RGBA8 on
 * a GPU without ASTC (decision B14), each transferred.
 *
 * The archive is a PMTiles file like the map's, read by the same client:
 * the header and the directory once, then one range request per tile. A
 * tile the directory does not list costs no request, which matters here
 * because most of the map has no models.
 *
 * The disk cache (IndexedDB, decision B12) is a database of its own, under
 * the archive's URL, with its own quota. An entry remembers the archive's
 * ETag: an archive published under one fixed name and overwritten is read
 * again, the tiles kept under the old upload missing (and pushed out by the
 * quota), so the map shows the new models with no cache to clear. With no
 * network the ETag cannot be asked for, and the tiles on disk still serve.
 * A tile on disk whose bytes do not decode is dropped, so the next request
 * reads the archive again.
 */

import init, { Archive, decodeModelTile, LocateKind } from "../../wasm/model_wasm/model_wasm.js";
import { ArchiveFailure, type ArchiveModule, PMTilesArchiveClient } from "../../tile/loading/archive-client.ts";
import { clearPreparedTileDatabase, openPreparedTileDatabase, PreparedTileDiskCache } from "../../tile/loading/prepared-tile-cache.ts";
import type { Tile } from "../../tile/tile.ts";
import { type FromModelTileWorker, type ModelTileMeta, modelTileDatabaseName, type ModelTileWorkerConfig, type ToModelTileWorker } from "./model-tile-worker-protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

interface State {
  archive: PMTilesArchiveClient;
  cache: PreparedTileDiskCache<null> | undefined;
  textureMode: 0 | 1;
}

let state: Promise<State> | undefined;

function post(message: FromModelTileWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

async function initialize(config: ModelTileWorkerConfig): Promise<State> {
  await init({ module_or_path: new URL("../../wasm/model_wasm/model_wasm_bg.wasm", import.meta.url) });
  const module: ArchiveModule = { Archive, LocateKind, tileId: (z, x, y) => Archive.tileId(z, x, y) };
  const archive = new PMTilesArchiveClient(module, config.archiveURL, config.requestHeaders);
  let cache: PreparedTileDiskCache<null> | undefined;
  if (config.diskCacheSizeInBytes > 0) {
    try {
      if (config.clearsDiskCache) await clearPreparedTileDatabase(modelTileDatabaseName);
      const db = await openPreparedTileDatabase(modelTileDatabaseName);
      // No time to live: an entry goes by the quota, or when its archive was uploaded again.
      cache = new PreparedTileDiskCache<null>(db, config.archiveURL, { byteQuota: config.diskCacheSizeInBytes, timeToLive: Infinity });
    } catch {
      // The cache is an optimisation: without it every tile comes from the archive.
      cache = undefined;
    }
  }
  post({ type: "ready" });
  return { archive, cache, textureMode: config.textureMode === "astc" ? 0 : 1 };
}

/** The archive's ETag, `undefined` without an answer (no network, or a host that sends none). */
async function archiveETag(s: State): Promise<string | undefined> {
  try {
    return await s.archive.archiveETag();
  } catch {
    return undefined;
  }
}

/** The tile's bytes from the disk, or from the archive and then kept on the disk, `undefined` for a tile the archive does not hold. */
async function tileBytes(s: State, tile: Tile): Promise<{ bytes: Uint8Array; fromDisk: boolean } | undefined> {
  const etag = s.cache === undefined ? undefined : await archiveETag(s);
  const cached = await s.cache?.get(tile, etag).catch(() => undefined);
  if (cached !== undefined && cached.arena.byteLength > 0) return { bytes: new Uint8Array(cached.arena), fromDisk: true };
  const outcome = await s.archive.tileBytes(tile.z, tile.x, tile.y);
  if (outcome.kind !== "tile" || outcome.bytes.byteLength === 0) return undefined;
  if (s.cache !== undefined) {
    // The save keeps its own copy: the bytes are decoded here and their blocks transferred.
    const copy = outcome.bytes.slice().buffer;
    void s.cache.put(tile, { arena: copy, meta: null, sourceETag: etag }).catch(() => undefined);
  }
  return { bytes: outcome.bytes, fromDisk: false };
}

async function load(id: number, tile: Tile): Promise<void> {
  const s = await state!;
  let found: { bytes: Uint8Array; fromDisk: boolean } | undefined;
  try {
    found = await tileBytes(s, tile);
  } catch (error) {
    const reason = error instanceof ArchiveFailure && error.failure.kind === "archiveUnreadable" ? `archive unreadable: ${error.failure.reason}` : String(error);
    post({ type: "failed", id, kind: "unavailable", reason });
    return;
  }
  if (found === undefined) {
    post({ type: "missing", id });
    return;
  }
  const start = performance.now();
  let decoded: ReturnType<typeof decodeModelTile>;
  try {
    decoded = decodeModelTile(found.bytes, tile.z, tile.x, tile.y, s.textureMode);
  } catch (error) {
    // The bytes may be a cached file gone bad: without it the next request reads the archive again.
    if (found.fromDisk) await s.cache?.remove(tile).catch(() => undefined);
    post({ type: "failed", id, kind: "unreadable", reason: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    const meta = JSON.parse(decoded.meta) as ModelTileMeta;
    const vertices = decoded.takeVertices() as Uint8Array<ArrayBuffer>;
    const indices = decoded.takeIndices() as Uint32Array<ArrayBuffer>;
    const texture = decoded.takeTexture() as Uint8Array<ArrayBuffer>;
    const decodeMilliseconds = performance.now() - start;
    post({ type: "tile", id, tile: { meta, vertices, indices, texture }, decodeMilliseconds }, [vertices.buffer, indices.buffer, texture.buffer]);
  } finally {
    decoded.free();
  }
}

self.onmessage = (event: MessageEvent<ToModelTileWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      state = initialize(message.config);
      state.catch((error: unknown) => post({ type: "init-error", message: String(error) }));
      break;
    case "load":
      load(message.id, message.tile).catch((error: unknown) => post({ type: "failed", id: message.id, kind: "unavailable", reason: String(error) }));
      break;
  }
};
