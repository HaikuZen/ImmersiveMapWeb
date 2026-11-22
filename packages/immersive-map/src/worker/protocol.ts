// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** Messages between the map's loader and its tile workers. */

import type { GroundReliefEncoding } from "../configuration/terrain-source.ts";
import type { DownloadFailure } from "../tile/loading/download-failure.ts";
import type { TerrainLoadResult } from "../tile/relief/store/terrain-fetch.ts";
import type { Tile } from "../tile/tile.ts";

export interface WorkerConfig {
  /** The PMTiles archive: an absolute URL, or a Blob for an offline map. */
  archive: string | Blob;
  requestHeaders: Record<string, string>;
  /** Lays the bundled overview into the tiles of zooms 0 to 7. */
  overviewEnabled: boolean;
  overviewURL: string;
  /** The prepared-tile cache, `undefined` when it is off. */
  cache: { namespace: string; byteQuota: number; timeToLive: number; sourceRevision: string } | undefined;
  /** What the parser is told, structured-cloneable (the Swift `TileParseOptions` and the style). */
  parse: unknown;
}

/** A tile's prepared form: the arena (its GPU bytes) and its CPU metadata. */
export interface PreparedTilePayload {
  arena: ArrayBuffer;
  meta: unknown;
}

export type ToWorker =
  | { type: "init"; config: WorkerConfig }
  | { type: "disk"; id: number; tile: Tile }
  | { type: "download"; id: number; tile: Tile }
  | { type: "prepare"; id: number; tile: Tile; handle: number; etag: string | undefined }
  | { type: "release"; handle: number }
  | { type: "remove"; tile: Tile }
  /** A terrain tile at `url` (the template already filled in), decoded by `encoding`. `source` names its template for the console. */
  | { type: "terrain"; id: number; tile: Tile; url: string; encoding: GroundReliefEncoding; source: string }
  | { type: "cancel"; id: number };

export type FromWorker =
  | { type: "ready"; available: [string, number][] | undefined }
  | { type: "init-error"; message: string }
  | { type: "disk"; id: number; prepared: PreparedTilePayload | undefined }
  | { type: "download"; id: number; result: { ok: true; handle: number; etag: string | undefined; bytes: number } | { ok: false; failure: DownloadFailure } }
  | { type: "prepare"; id: number; prepared: PreparedTilePayload | undefined; timings: { parse: number } }
  | { type: "terrain"; id: number; result: TerrainLoadResult }
  | { type: "saved"; tile: Tile }
  /** The archive's deepest zoom, read from its header once a session, at the first download. */
  | { type: "archiveDepth"; maxZoom: number }
  | { type: "error"; id: number; message: string };
