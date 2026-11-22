// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The frame's raster sources and what their textures are drawn from: the
 * CPU half of the Swift `RasterTileRenderSubsystem.update`.
 */

import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import type { PlaceTile, ResidentTile } from "../placement/place-tile.ts";
import { GroundStyleRunFlag, type GroundStyleRun, styleFadeProgress } from "../store/tile-gpu.ts";
import type { Tile } from "../tile.ts";
import { tileKey } from "../tile.ts";

/**
 * A wrap copy a source is drawn at, and the terrain it shades by and rises
 * by there: the finest of its placements' (`PlaceTile.terrain`,
 * `displacement`), `undefined` off the relief.
 */
export interface RasterPlacement {
  readonly worldWrap: number;
  terrain: Tile | undefined;
  displacement: Tile | undefined;
}

/** One tile drawn into a texture this frame, and where it is drawn: once per wrap copy of the flat world it is placed at. */
export interface RasterSource<R extends ResidentTile> {
  readonly resident: R;
  /** The source's `tileKey`, what its texture is kept under. */
  readonly key: string;
  /** The texture's side: the largest raster size among the source's raster placements. */
  size: number;
  readonly placements: RasterPlacement[];
}

/**
 * The frame's raster placements, grouped by the tile drawn: a tile placed
 * in several raster slots draws into one texture, of the largest size among
 * them, and is drawn once per wrap copy it is placed at, at full extent.
 * The placement prepass has settled which source a pixel shows
 * (`TileSourceStencilPriority`), and the sources are ordered finest first
 * for the pipeline's sake alone.
 *
 * A source has one representation a frame: a tile drawn as geometry
 * anywhere (a stand-in carrying the vector rules it was shown with) draws
 * no texture, its geometry at full extent covers its raster slots too.
 * Drawn both ways, the two would share one stencil mark and meet by depth,
 * which on a relief, where their meshes sample the terrain apart, leaves
 * patches of each.
 */
export function rasterSources<R extends ResidentTile>(placements: readonly PlaceTile<R>[]): RasterSource<R>[] {
  if (!placements.some((p) => p.rules.raster !== undefined)) return [];
  const vectorTiles = new Set<string>();
  for (const p of placements) if (p.rules.raster === undefined) vectorTiles.add(tileKey(p.resident.tile));
  const sources: RasterSource<R>[] = [];
  const indexByKey = new Map<string, number>();
  for (const p of placements) {
    const target = p.rules.raster;
    if (target === undefined) continue;
    const key = tileKey(p.resident.tile);
    if (vectorTiles.has(key)) continue;
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = sources.length;
      indexByKey.set(key, index);
      sources.push({ resident: p.resident, key, size: target.size, placements: [] });
    }
    const source = sources[index]!;
    source.size = Math.max(source.size, target.size);
    const worldWrap = p.placeIn.worldWrap;
    const placement = source.placements.find((existing) => existing.worldWrap === worldWrap);
    if (placement) {
      if (p.terrain && p.terrain.z > (placement.terrain?.z ?? -1)) placement.terrain = p.terrain;
      if (p.displacement && p.displacement.z > (placement.displacement?.z ?? -1)) placement.displacement = p.displacement;
    } else {
      source.placements.push({ worldWrap, terrain: p.terrain, displacement: p.displacement });
    }
  }
  // The plane's order: by the tile-priority reference, finest first. The
  // sphere orders by zoom, the same order for references.
  return sources.sort((a, b) => TileSourceStencilPriority.reference(b.resident.tile.z) - TileSourceStencilPriority.reference(a.resident.tile.z));
}

/**
 * The steps a style's fade is drawn in a texture at: the texture is drawn
 * again when a fade moves by a step, at most a 64th of its alpha off
 * between two draws, under anything the eye sees.
 */
export const RASTER_FADE_STEPS = 64;

/**
 * What a tile's texture is drawn from at a zoom: its fill runs' fades, each
 * in `RASTER_FADE_STEPS` steps, the one thing of the draw that moves with
 * the camera. Equal signatures of one tile draw one texture. FNV-1a over
 * the steps, in 32 bits (the Swift hash is 64-bit): a signature is only
 * ever compared with the same tile's previous one, where a collision
 * would take a 2^-32 chance on one fade change.
 */
export function rasterBakeSignature(runs: readonly GroundStyleRun[], planningZoom: number): number {
  let hash = 0x811c9dc5;
  for (const run of runs) {
    if ((run.flags & GroundStyleRunFlag.linesClass) !== 0) continue;
    const step = Math.round(styleFadeProgress(run.zoomFade, planningZoom) * RASTER_FADE_STEPS);
    hash = Math.imul(hash ^ step, 0x01000193) >>> 0;
  }
  return hash;
}
