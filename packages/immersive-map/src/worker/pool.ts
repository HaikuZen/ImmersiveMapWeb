// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The tile workers as the loader's pipeline: each stage of `TileLoader` is a
 * message to a worker, and the materialize (the GPU upload into the render
 * store) runs here, on the main thread, as the stage's answer arrives. Each
 * worker has its own Wasm instance (no shared memory, so no cross-origin
 * isolation is asked of the host page). A tile always goes to the worker of
 * its 8x8 block: its download's bytes stay in that worker for its parse, and
 * neighbours share the leaf directories it holds.
 *
 * The availability index (the Swift `PreparedTileAvailabilityIndex`) lives
 * here: seeded from the cache when the workers start, kept current by their
 * saves, so `isPreparedOnDisk` is a set lookup.
 *
 * The workers fetch and decode the relief's terrain tiles too
 * (`loadTerrain`): a terrain tile goes to a worker by its own address, as
 * it shares nothing with its neighbours.
 */

import type { DownloadOutcome, MaterializeOutcome, PrepareOutcome, TileLoadPipeline, TileParseLayerTiming } from "../tile/loading/tile-loader.ts";
import { type TerrainLoadRequest, type TerrainLoadResult, terrainTileURL } from "../tile/relief/store/terrain-fetch.ts";
import { type Tile, tileKey } from "../tile/tile.ts";
import type { FromWorker, PreparedTilePayload, ToWorker, WorkerConfig } from "./protocol.ts";
import { workerFailure } from "./worker-failure.ts";

export interface DownloadHandle {
  worker: number;
  handle: number;
}

const noLayerTimings: readonly TileParseLayerTiming[] = Object.freeze([]);

type Pending = { resolve: (message: FromWorker) => void; reject: (error: Error) => void; worker: number };

export class WorkerTilePipeline implements TileLoadPipeline<DownloadHandle> {
  readonly hasPreparedDiskCache: boolean;
  readonly ready: Promise<void>;
  /** Turns a prepared tile into GPU state, on the main thread. */
  materialize: (tile: Tile, prepared: PreparedTilePayload) => MaterializeOutcome = () => "allocationOrStoreFailed";
  onParsed: ((tile: Tile, timings: { parse: number }) => void) | undefined;
  /** The archive's deepest zoom as a worker read it from the header. */
  onArchiveDepth: ((maxZoom: number) => void) | undefined;

  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly available = new Set<string>();
  /** The workers that failed, by index, and their errors. */
  private readonly failures = new Map<number, Error>();
  private nextId = 1;

  constructor(config: WorkerConfig, size: number) {
    this.hasPreparedDiskCache = config.cache !== undefined;
    const readies: Promise<void>[] = [];
    for (let index = 0; index < size; index++) {
      const worker = new Worker(new URL("./tile-worker.ts", import.meta.url), { type: "module", name: `tiles-${index}` });
      readies.push(
        new Promise((resolve, reject) => {
          worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
            const message = event.data;
            if (message.type === "ready") {
              for (const [key] of message.available ?? []) this.available.add(key);
              resolve();
            } else if (message.type === "init-error") {
              reject(new Error(message.message));
            } else if (message.type === "archiveDepth") {
              this.onArchiveDepth?.(message.maxZoom);
            } else if (message.type === "saved") {
              this.available.add(tileKey(message.tile));
            } else {
              this.receive(message);
            }
          });
          // A script that does not load, or throws, sends no message: the
          // map is not built on it (ready rejects), and its tiles fail.
          worker.addEventListener("error", (event) => {
            event.preventDefault();
            const error = workerFailure("tile worker", event);
            reject(error);
            this.fail(index, error);
          });
        }),
      );
      worker.postMessage({ type: "init", config } satisfies ToWorker);
      this.workers.push(worker);
    }
    this.ready = Promise.all(readies).then(() => undefined);
  }

  destroy(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    for (const pending of this.pending.values()) pending.reject(new Error("the tile workers stopped"));
    this.pending.clear();
  }

  isPreparedOnDisk(tile: Tile): boolean {
    return this.available.has(tileKey(tile));
  }

  async readDisk(tile: Tile, signal: AbortSignal): Promise<MaterializeOutcome | undefined> {
    const answer = await this.call(tile, (id) => ({ type: "disk", id, tile }), signal);
    if (answer.type !== "disk" || !answer.prepared) return undefined;
    return this.materialize(tile, answer.prepared);
  }

  removeDiskEntry(tile: Tile): void {
    this.available.delete(tileKey(tile));
    this.workers[this.workerOf(tile)]?.postMessage({ type: "remove", tile } satisfies ToWorker);
  }

  async download(tile: Tile, signal: AbortSignal): Promise<DownloadOutcome<DownloadHandle>> {
    const answer = await this.call(tile, (id) => ({ type: "download", id, tile }), signal);
    if (answer.type !== "download") throw new Error("unexpected answer");
    if (!answer.result.ok) return answer.result;
    return { ok: true, handle: { worker: this.workerOf(tile), handle: answer.result.handle }, etag: answer.result.etag, bytes: answer.result.bytes };
  }

  /** The parser reports no per-layer timings, so `onParsed` hears an empty list: the parse stage's own duration is what the panel shows. */
  async prepare(
    tile: Tile,
    download: { handle: DownloadHandle; etag: string | undefined },
    signal: AbortSignal,
    onParsed?: (layerTimings: readonly TileParseLayerTiming[]) => void,
  ): Promise<PrepareOutcome> {
    let answer: FromWorker;
    try {
      answer = await this.call(tile, (id) => ({ type: "prepare", id, tile, handle: download.handle.handle, etag: download.etag }), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, reason: "parseFailed" };
    }
    if (answer.type !== "prepare" || !answer.prepared) return { ok: false, reason: "parseFailed" };
    this.onParsed?.(tile, answer.timings);
    onParsed?.(noLayerTimings);
    return { ok: true, materialize: this.materialize(tile, answer.prepared) };
  }

  /**
   * A terrain tile's heights, fetched and decoded by a worker (the Swift
   * `GroundReliefURLTerrainSource`): `missing` for an HTTP 404, a template
   * that makes no URL or an image that does not decode. Rejects for a load
   * that failed (no answer, another status), which the caller tries again.
   * A relative template is resolved against the page.
   */
  async loadTerrain(tile: Tile, request: TerrainLoadRequest, signal: AbortSignal): Promise<TerrainLoadResult> {
    const url = terrainTileURL(request.tileURLTemplate, tile, globalThis.location?.href);
    if (url === undefined) return { kind: "missing" };
    const message = (id: number): ToWorker => ({ type: "terrain", id, tile, url, encoding: request.encoding, source: request.tileURLTemplate });
    const answer = await this.call(tile, message, signal, this.terrainWorkerOf(tile));
    if (answer.type !== "terrain") throw new Error("unexpected answer");
    return answer.result;
  }

  releaseDownload(handle: DownloadHandle): void {
    this.workers[handle.worker]?.postMessage({ type: "release", handle: handle.handle } satisfies ToWorker);
  }

  private workerOf(tile: Tile): number {
    const hash = (((tile.x >> 3) * 73856093) ^ ((tile.y >> 3) * 19349663) ^ (tile.z * 83492791)) >>> 0;
    return hash % this.workers.length;
  }

  /** A terrain tile's worker, by the tile's own address. */
  private terrainWorkerOf(tile: Tile): number {
    const hash = (Math.imul(tile.x, 73856093) ^ Math.imul(tile.y, 19349663) ^ Math.imul(tile.z, 83492791)) >>> 0;
    return hash % this.workers.length;
  }

  private call(tile: Tile, make: (id: number) => ToWorker, signal: AbortSignal, worker = this.workerOf(tile)): Promise<FromWorker> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const failure = this.failures.get(worker);
      if (failure) {
        reject(failure);
        return;
      }
      this.pending.set(id, { resolve, reject, worker });
      signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.workers[worker]?.postMessage({ type: "cancel", id } satisfies ToWorker);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
      this.workers[worker]!.postMessage(make(id));
    });
  }

  /** A worker that failed: its calls on their way reject, and every later one at once. */
  private fail(worker: number, error: Error): void {
    this.failures.set(worker, error);
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private receive(message: FromWorker): void {
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message);
  }
}
