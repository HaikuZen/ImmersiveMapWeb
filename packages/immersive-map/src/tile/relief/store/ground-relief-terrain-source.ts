// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GroundReliefEncoding } from "../../../configuration/terrain-source.ts";
import type { Tile } from "../../tile.ts";

/** A terrain tile decoded: its heights as half floats, row by row from the north edge, `size` a side, and their range in metres. */
export interface GroundReliefHeights {
  readonly size: number;
  readonly halves: Uint16Array;
  readonly minMetres: number;
  readonly maxMetres: number;
}

/** What a terrain source answered for a tile. */
export type GroundReliefTerrainResponse =
  | { readonly kind: "heights"; readonly heights: GroundReliefHeights }
  /** The source has no terrain tile there. */
  | { readonly kind: "missing" };

/**
 * Where the terrain tiles' heights come from (`GroundReliefStore`), a port
 * of the Swift `GroundReliefTerrainSource`: a tile's heights, or word that
 * the source has no such tile. The store knows nothing of URLs, image
 * formats or encodings: a source of another kind is a new implementation,
 * and the store does not change.
 *
 * A rejected promise is a load that failed, tried again after a pause that
 * grows with each failure. A tile the source has but cannot be read is no
 * failure of the moment: the source answers `missing` for it, and the store
 * asks for its ancestor in its place. The tile's occlusion of the sky is
 * computed on the GPU once its heights are in.
 */
export interface GroundReliefTerrainSource {
  heights(tile: Tile, signal: AbortSignal): Promise<GroundReliefTerrainResponse>;
}

/** The URL of a terrain tile by a template with `{z}`, `{x}` and `{y}` (the Swift `GroundReliefURLTerrainSource.url(for:)`). */
export function groundReliefTileURL(tileURLTemplate: string, tile: Tile): string {
  return tileURLTemplate.replaceAll("{z}", String(tile.z)).replaceAll("{x}", String(tile.x)).replaceAll("{y}", String(tile.y));
}

/** What a terrain tile's URL is loaded and decoded with: the map's tile workers (`WorkerTilePipeline.loadTerrain`). */
export interface GroundReliefTerrainLoader {
  loadTerrain(
    tile: Tile,
    request: { readonly tileURLTemplate: string; readonly encoding: GroundReliefEncoding },
    signal: AbortSignal,
  ): Promise<GroundReliefTerrainResponse>;
}

/**
 * Terrain tiles as images at a URL template
 * (`ImmersiveMapTerrainSource.tileURLTemplate`), fetched and decoded by
 * their encoding in the tile workers (in Wasm): the
 * Swift `GroundReliefURLTerrainSource`. An HTTP 404 is a tile the source
 * does not have, and so is an image the decoder cannot read.
 */
export class GroundReliefURLTerrainSource implements GroundReliefTerrainSource {
  constructor(
    readonly tileURLTemplate: string,
    readonly encoding: GroundReliefEncoding,
    private readonly loader: GroundReliefTerrainLoader,
  ) {}

  heights(tile: Tile, signal: AbortSignal): Promise<GroundReliefTerrainResponse> {
    return this.loader.loadTerrain(tile, { tileURLTemplate: this.tileURLTemplate, encoding: this.encoding }, signal);
  }
}
