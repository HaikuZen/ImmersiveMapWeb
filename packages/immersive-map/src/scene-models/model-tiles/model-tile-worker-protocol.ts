// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The messages between the main thread and the model tile worker
 * (`model-tile-worker.ts`). A decoded tile crosses as its three blocks,
 * transferred, and its metadata as a plain object.
 */

import type { Tile } from "../../tile/tile.ts";

/** The database the model tiles are kept in, apart from the prepared map tiles' and their quota. */
export const modelTileDatabaseName = "immersive-map-model-tiles";

/** How the worker prepares a tile's textures: the ASTC blocks as stored, or decoded to RGBA8 for a GPU without `texture-compression-astc` (decision B14). */
export type ModelTileTextureMode = "astc" | "rgba8";

export interface ModelTileWorkerConfig {
  /** The archive's absolute URL. */
  readonly archiveURL: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** The byte quota of the tiles kept on disk, 0 for none. */
  readonly diskCacheSizeInBytes: number;
  /** Clear the tiles kept on disk before the first load (`TileCacheSettings.clearDiskCachesOnLaunch`). */
  readonly clearsDiskCache: boolean;
  readonly textureMode: ModelTileTextureMode;
}

/** One mip level of a decoded tile's texture: its size, how `writeTexture` reads it, and where its layer 0 starts (the layers of a level follow one another). */
export interface ModelTileTextureLevel {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly rowsPerImage: number;
  readonly layerByteCount: number;
  readonly byteOffset: number;
}

/** A decoded tile's metadata, as the model Wasm module's `DecodedModelTile.meta` writes it. */
export interface ModelTileMeta {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly boundsMinimum: readonly [number, number, number];
  readonly boundsMaximum: readonly [number, number, number];
  /** The stored positions into tile space, column-major (`ModelTileContents.positionMatrix`). */
  readonly positionMatrix: readonly number[];
  readonly texture: {
    readonly format: ModelTileTextureMode;
    readonly width: number;
    readonly height: number;
    readonly mipLevelCount: number;
    readonly layerCount: number;
    readonly blockEdge: number;
    readonly levels: readonly ModelTileTextureLevel[];
  };
  readonly models: readonly {
    readonly id: string;
    readonly firstIndex: number;
    readonly indexCount: number;
    readonly boundsMinimum: readonly [number, number, number];
    readonly boundsMaximum: readonly [number, number, number];
    readonly latitude: number;
    readonly longitude: number;
    readonly altitudeMeters: number;
  }[];
  /** The map's tile feature ids the tile's models stand in for, by the zoom of the map tiles each list is for. */
  readonly replacedBuildingIds: Readonly<Record<string, readonly number[]>>;
}

/** A tile ready for the GPU: its metadata and its blocks. */
export interface DecodedModelTile {
  readonly meta: ModelTileMeta;
  readonly vertices: Uint8Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly texture: Uint8Array<ArrayBuffer>;
}

export type ToModelTileWorker = { readonly type: "init"; readonly config: ModelTileWorkerConfig } | { readonly type: "load"; readonly id: number; readonly tile: Tile };

export type FromModelTileWorker =
  | { readonly type: "ready" }
  | { readonly type: "init-error"; readonly message: string }
  | { readonly type: "tile"; readonly id: number; readonly tile: DecodedModelTile; readonly decodeMilliseconds: number }
  | { readonly type: "missing"; readonly id: number }
  | { readonly type: "failed"; readonly id: number; readonly kind: "unreadable" | "unavailable"; readonly reason: string };
