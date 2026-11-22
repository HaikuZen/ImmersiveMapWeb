// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The overview of the globe the engine ships: a small PMTiles archive in the
 * package's assets (`assets/overview.pmtiles`) whose tiles are laid into the
 * map's own tiles at the zooms it covers, tile zoom 0 to 7. A port of the
 * Swift `OverviewTileSource`.
 *
 * The archive is two layers of polygons and one of lines: `biome` (the
 * fourteen biomes of RESOLVE Ecoregions 2017, CC BY 4.0, fitted to the
 * Natural Earth coast), `lake` (the 1:110m lakes at zoom 0) and `road` (the
 * Natural Earth 1:10m roads at zooms 2 to 5). The merge is bytes: an MVT tile
 * is a protobuf of repeated `layer` fields, so the overview tile appended to
 * the map tile is one tile with both tiles' layers. Nothing here knows what a
 * layer means: the style reads them by name. Runs in a tile worker.
 */

import { type ArchiveModule, PMTilesArchiveClient } from "../loading/archive-client.ts";
import { NoticeThrottle } from "../loading/tile-downloader.ts";
import type { Tile } from "../tile.ts";

export const overviewCreditText = "Biomes © RESOLVE, CC BY 4.0";

/** The bundled archive's URL, resolved by the bundler next to the library. */
export const bundledOverviewURL = new URL("../../../assets/overview.pmtiles", import.meta.url).href;

export class OverviewTileSource {
  private readonly archive: PMTilesArchiveClient;

  constructor(module: ArchiveModule, source: string | Blob = bundledOverviewURL) {
    this.archive = new PMTilesArchiveClient(module, source);
  }

  /**
   * The overview's bytes for the tile, decompressed, or `undefined`: a zoom
   * past the archive's, a tile it does not carry (open ocean), or an archive
   * that cannot be read, logged once a minute.
   */
  async tileBytes(tile: Tile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    try {
      const outcome = await this.archive.tileBytes(tile.z, tile.x, tile.y, signal);
      return outcome.kind === "tile" && outcome.bytes.length > 0 ? outcome.bytes : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (NoticeThrottle.overviewUnreadable.shouldLog()) {
        console.warn(`ImmersiveMap: the overview archive could not be read (${String(error)}), so the overview zooms draw the tile source's own land cover.`);
      }
      return undefined;
    }
  }

  /** The map tile with the overview's layers laid in: the two messages concatenated. */
  static merge(mapTile: Uint8Array, overview: Uint8Array): Uint8Array<ArrayBuffer> {
    const merged = new Uint8Array(mapTile.length + overview.length);
    merged.set(mapTile, 0);
    merged.set(overview, mapTile.length);
    return merged;
  }
}
