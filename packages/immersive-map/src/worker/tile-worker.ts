// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/// <reference lib="webworker" />

/**
 * A tile worker: the stages of the loader that do not touch the GPU, the
 * worker half of the Swift `DefaultTileLoadPipeline`. The disk stage reads
 * the prepared cache (IndexedDB), the network stage downloads the tile from
 * the archive and lays the overview in, the CPU stage parses it with the
 * Wasm parser and saves the result. A download keeps its bytes here under a
 * handle until the CPU stage of the same tile takes them, so the bytes never
 * cross to the main thread. Prepared tiles go back as transferred buffers.
 * The relief's terrain tiles are fetched and decoded here too (in Wasm), their heights sent back as transferred half floats.
 */

import init, { Archive, decodeTerrainTile, LocateKind, TileParser as TileParser_ } from "../wasm/worker_wasm/worker_wasm.js";
import { type ArchiveModule, PMTilesArchiveClient } from "../tile/loading/archive-client.ts";
import { TileArchiveVersion } from "../tile/loading/archive-version.ts";
import { openPreparedTileDatabase, PreparedTileDiskCache } from "../tile/loading/prepared-tile-cache.ts";
import { TileDownloader } from "../tile/loading/tile-downloader.ts";
import { OverviewTileSource } from "../tile/overview/overview-tile-source.ts";
import { fetchTerrainTile, type TerrainDecode } from "../tile/relief/store/terrain-fetch.ts";
import type { Tile } from "../tile/tile.ts";
import type { FromWorker, PreparedTilePayload, ToWorker, WorkerConfig } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

/** The overview covers tile zooms 0 to 7. */
const OVERVIEW_MAXIMUM_ZOOM = 7;

/** The parse stage: the bytes of one tile to its prepared form. */
interface TileParser {
  parse(bytes: Uint8Array, tile: Tile): PreparedTilePayload;
}

/**
 * The Wasm parser (crates/tile-parse through crates/worker-wasm): the tile's
 * GPU arena and the metadata JSON beside it, read here so the main thread
 * receives a structured object.
 */
class ArenaParser implements TileParser {
  constructor(private readonly parser: TileParser_) {}

  parse(bytes: Uint8Array, tile: Tile): PreparedTilePayload {
    const parsed = this.parser.parse(bytes, tile.z, tile.x, tile.y);
    const arena = parsed.takeArena();
    const meta: unknown = JSON.parse(parsed.meta);
    parsed.free();
    return { arena: arena.buffer as ArrayBuffer, meta };
  }
}

interface State {
  downloader: TileDownloader;
  overview: OverviewTileSource | undefined;
  cache: PreparedTileDiskCache<unknown> | undefined;
  version: TileArchiveVersion | undefined;
  parser: TileParser;
}

let state: Promise<State> | undefined;
let nextHandle = 1;
const downloads = new Map<number, { bytes: Uint8Array<ArrayBuffer>; tile: Tile }>();
const inFlight = new Map<number, AbortController>();

function post(message: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

async function initialize(config: WorkerConfig): Promise<State> {
  await init({ module_or_path: new URL("../wasm/worker_wasm/worker_wasm_bg.wasm", import.meta.url) });
  const module: ArchiveModule = { Archive, LocateKind, tileId: (z, x, y) => Archive.tileId(z, x, y) };
  const downloader = new TileDownloader(new PMTilesArchiveClient(module, config.archive, config.requestHeaders));
  const overview = config.overviewEnabled ? new OverviewTileSource(module, config.overviewURL) : undefined;
  // The parser's configuration is JSON (the Swift `TileParseOptions`, the theme, the label language and glyphs).
  const parser = new TileParser_(typeof config.parse === "string" ? config.parse : JSON.stringify(config.parse ?? {}));
  let cache: PreparedTileDiskCache<unknown> | undefined;
  let version: TileArchiveVersion | undefined;
  let available: [string, number][] | undefined;
  if (config.cache) {
    const { namespace, byteQuota, timeToLive, sourceRevision } = config.cache;
    const db = await openPreparedTileDatabase();
    // The arena format, what the style bakes and how the text is laid out are part of the cache's identity: another revision is another namespace.
    const c = new PreparedTileDiskCache<unknown>(db, `${namespace}/format-${parser.formatVersion}/style-${parser.styleRevision}/text-${parser.textRevision}`, { byteQuota, timeToLive });
    cache = c;
    available = [...(await c.availableTiles()).entries()];
    // A local archive is not checked: it has no ETag.
    if (typeof config.archive === "string") {
      version = new TileArchiveVersion(await c.rememberedArchiveETag(sourceRevision), module.tileId, (etag) => void c.rememberArchiveETag(sourceRevision, etag));
    }
  }
  post({ type: "ready", available });
  return { downloader, overview, cache, version, parser: new ArenaParser(parser) };
}

/** Asks the archive for its ETag once a session: a map whose tiles are all on disk downloads nothing. */
function startArchiveCheckIfNeeded(s: State): void {
  if (!s.version?.beginCheck()) return;
  s.downloader.archiveETag().then(
    (etag) => s.version?.recordArchiveETag(etag),
    () => s.version?.recordUnreachable(),
  );
}

async function readDisk(id: number, tile: Tile): Promise<void> {
  const s = await state!;
  if (!s.cache) {
    post({ type: "disk", id, prepared: undefined });
    return;
  }
  startArchiveCheckIfNeeded(s);
  const entry = await s.cache.get(tile, s.version?.expectedSourceETag(tile.z, tile.x, tile.y));
  if (!entry) {
    post({ type: "disk", id, prepared: undefined });
    return;
  }
  post({ type: "disk", id, prepared: { arena: entry.arena, meta: entry.meta } }, [entry.arena]);
}

let archiveDepthChecked = false;

/**
 * Reads the archive's depth once a session, at the first download (the Swift
 * `startArchiveDepthCheckIfNeeded`): a failure leaves the depth the map kept.
 */
function startArchiveDepthCheckIfNeeded(s: State): void {
  if (archiveDepthChecked) return;
  archiveDepthChecked = true;
  s.downloader.archiveMaximumZoom().then(
    (maxZoom) => post({ type: "archiveDepth", maxZoom }),
    () => undefined,
  );
}

async function download(id: number, tile: Tile, signal: AbortSignal): Promise<void> {
  const s = await state!;
  startArchiveDepthCheckIfNeeded(s);
  const result = await s.downloader.download(tile, signal);
  // Every answer says which upload the archive is now, and a request that did
  // not arrive says the disk is all there is for the moment.
  if (result.ok) s.version?.recordSourceETag(result.etag);
  else if (result.failure.kind === "network") s.version?.recordUnreachable();
  if (!result.ok) {
    post({ type: "download", id, result });
    return;
  }
  let bytes = result.bytes;
  if (s.overview && tile.z <= OVERVIEW_MAXIMUM_ZOOM) {
    const overview = await s.overview.tileBytes(tile, signal);
    if (overview) bytes = OverviewTileSource.merge(bytes, overview);
  }
  const handle = nextHandle++;
  downloads.set(handle, { bytes, tile });
  post({ type: "download", id, result: { ok: true, handle, etag: result.etag, bytes: bytes.length } });
}

async function prepare(id: number, tile: Tile, handle: number, etag: string | undefined): Promise<void> {
  const s = await state!;
  const download = downloads.get(handle);
  downloads.delete(handle);
  if (!download) {
    post({ type: "prepare", id, prepared: undefined, timings: { parse: 0 } });
    return;
  }
  // A second engine sharing the namespace may have saved the entry between
  // the disk miss and the download: reuse it when it is from these very bytes.
  if (s.cache && etag) {
    const cached = await s.cache.get(tile, etag);
    if (cached) {
      post({ type: "prepare", id, prepared: { arena: cached.arena, meta: cached.meta }, timings: { parse: 0 } }, [cached.arena]);
      return;
    }
  }
  const start = performance.now();
  let prepared: PreparedTilePayload;
  try {
    prepared = s.parser.parse(download.bytes, tile);
  } catch (error) {
    post({ type: "error", id, message: `parse failed: ${String(error)}` });
    return;
  }
  const parse = performance.now() - start;
  if (s.cache) {
    // The save keeps its own copy: the arena itself goes to the main thread.
    const copy = prepared.arena.slice(0);
    void s.cache.put(tile, { arena: copy, meta: prepared.meta, sourceETag: etag }).then(() => post({ type: "saved", tile }));
  }
  post({ type: "prepare", id, prepared, timings: { parse } }, [prepared.arena]);
}

/** A terrain image to its half floats in the worker's Wasm (crates/ground-relief): throws for an image it cannot read. */
const decodeTerrain: TerrainDecode = (bytes, encoding) => {
  const decoded = decodeTerrainTile(bytes, encoding === "mapbox" ? 1 : 0);
  try {
    const halves = decoded.takeHalves() as Uint16Array<ArrayBuffer>;
    return { size: decoded.size, halves, minMetres: decoded.minMetres, maxMetres: decoded.maxMetres };
  } finally {
    decoded.free();
  }
};

async function terrain(id: number, message: Extract<ToWorker, { type: "terrain" }>, signal: AbortSignal): Promise<void> {
  // The Wasm module is instantiated by the worker's initialization.
  await state!;
  const result = await fetchTerrainTile(message.url, message.tile, message.encoding, message.source, decodeTerrain, signal);
  post({ type: "terrain", id, result }, result.kind === "heights" ? [result.halves.buffer] : []);
}

function run(id: number, work: (signal: AbortSignal) => Promise<void>): void {
  const controller = new AbortController();
  inFlight.set(id, controller);
  work(controller.signal)
    .catch((error: unknown) => {
      if (!controller.signal.aborted) post({ type: "error", id, message: String(error) });
    })
    .finally(() => inFlight.delete(id));
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      state = initialize(message.config);
      state.catch((error: unknown) => post({ type: "init-error", message: String(error) }));
      break;
    case "disk":
      run(message.id, () => readDisk(message.id, message.tile));
      break;
    case "download":
      run(message.id, (signal) => download(message.id, message.tile, signal));
      break;
    case "prepare":
      run(message.id, () => prepare(message.id, message.tile, message.handle, message.etag));
      break;
    case "terrain":
      run(message.id, (signal) => terrain(message.id, message, signal));
      break;
    case "release":
      downloads.delete(message.handle);
      break;
    case "remove":
      void state?.then((s) => s.cache?.remove(message.tile));
      break;
    case "cancel":
      inFlight.get(message.id)?.abort();
      break;
  }
};
