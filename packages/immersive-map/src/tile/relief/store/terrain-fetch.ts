// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GroundReliefEncoding } from "../../../configuration/terrain-source.ts";
import type { Tile } from "../../tile.ts";
import { groundReliefTileURL } from "./ground-relief-terrain-source.ts";

/** What a terrain tile is loaded with: its URL template and how its pixels hold heights. */
export interface TerrainLoadRequest {
  readonly tileURLTemplate: string;
  readonly encoding: GroundReliefEncoding;
}

/**
 * What a tile worker answered for a terrain tile (`WorkerTilePipeline.loadTerrain`):
 * its heights as half floats' bits, `size` squared, row 0 north, and their
 * range in metres, or word that the source has no such tile. The occlusion
 * of the sky is not computed here: the GPU computes it from the uploaded
 * heights (`GroundReliefOcclusionGpu`).
 */
export type TerrainLoadResult =
  | { readonly kind: "heights"; readonly size: number; readonly halves: Uint16Array<ArrayBuffer>; readonly minMetres: number; readonly maxMetres: number }
  | { readonly kind: "missing" };

/** A terrain image decoded (the worker's Wasm, `decodeTerrainTile`): throws for an image it cannot read. */
export type TerrainDecode = (bytes: Uint8Array, encoding: GroundReliefEncoding) => {
  size: number;
  halves: Uint16Array<ArrayBuffer>;
  minMetres: number;
  maxMetres: number;
};

/**
 * The URL of a terrain tile, the Swift `GroundReliefURLTerrainSource.url(for:)`:
 * the template's `{z}`, `{x}` and `{y}` replaced, a relative template
 * resolved against `base` (the page, on the main thread). `undefined` for
 * a template that makes no URL, a tile the source does not have.
 */
export function terrainTileURL(tileURLTemplate: string, tile: Tile, base: string | undefined): string | undefined {
  try {
    return new URL(groundReliefTileURL(tileURLTemplate, tile), base).href;
  } catch {
    return undefined;
  }
}

/** The sources whose undecodable tiles were already reported: one line a source, not one a tile. */
const reportedSources = new Set<string>();

/**
 * Fetches and decodes a terrain tile in a worker, the Swift
 * `GroundReliefURLTerrainSource.heights(of:)`: an HTTP 404 or an image the
 * decoder cannot read is a tile the source does not have (`missing`, the
 * latter reported on the console once a source, by `source`). A request
 * that does not arrive, or any other status than 2xx and 404, rejects so the
 * store tries again later.
 */
export async function fetchTerrainTile(
  url: string,
  tile: Tile,
  encoding: GroundReliefEncoding,
  source: string,
  decode: TerrainDecode,
  signal: AbortSignal,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<TerrainLoadResult> {
  const response = await fetcher(url, { signal });
  if (response.status === 404) return { kind: "missing" };
  if (response.status < 200 || response.status >= 300) throw new Error(`terrain tile ${tile.z}/${tile.x}/${tile.y}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    return { kind: "heights", ...decode(bytes, encoding) };
  } catch (error) {
    if (!reportedSources.has(source)) {
      reportedSources.add(source);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `ImmersiveMap: terrain tile ${tile.z}/${tile.x}/${tile.y} cannot be decoded (${reason}). Check that the terrain source serves images in its encoding.`,
      );
    }
    return { kind: "missing" };
  }
}
