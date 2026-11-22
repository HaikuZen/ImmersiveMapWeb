// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Tile } from "../../tile.ts";
import type { GroundReliefTile, ReliefTexture } from "../store/ground-relief-tile.ts";

/**
 * The heights a flattened ground tile rises by, a port of the Swift
 * `GroundRelief`: a terrain tile's heights in metres as a texture, and
 * where the ground tile lies in it, the terrain tile being the ground
 * tile's own or an ancestor's. With them the frame's strength: a point of
 * the ground rises by its height over the datum, times the strength the
 * frame's zoom leaves of the relief.
 */
export class GroundRelief {
  constructor(
    /** The terrain tile's heights, the texture the vertex stages sample and the same numbers the CPU reads. */
    readonly terrain: GroundReliefTile,
    /** The ground tile's north-west corner in the texture, in 0 to 1. */
    readonly originX: number,
    readonly originY: number,
    /** The ground tile's side in the texture, in 0 to 1: 1 for the tile's own terrain, a half for its parent's. */
    readonly scale: number,
    /** How much taller than the terrain the ground is drawn this frame. */
    readonly strength: number,
    /** The terrain tile's occlusion of the sky over the same square, `undefined` while it is not computed, which draws no darkening. */
    readonly occlusion: ReliefTexture | undefined = undefined,
  ) {}

  get texture(): ReliefTexture {
    return this.terrain.texture;
  }

  /** The terrain's height in metres under a point of the ground tile, in the tile's uv (v from the north edge), bilinear as the vertex stage samples it. */
  metresAtTileUV(u: number, v: number): number {
    const cu = Math.min(Math.max(u, 0), 1);
    const cv = Math.min(Math.max(v, 0), 1);
    return this.terrain.metresAtTextureUV(this.originX + cu * this.scale, this.originY + cv * this.scale);
  }

  /** The metres a point of the tile is drawn at over the datum, the frame's strength in them: what to multiply by the world units per metre. */
  drawnMetresAtTileUV(u: number, v: number, datumMetres: number): number {
    return (this.metresAtTileUV(u, v) - datumMetres) * this.strength;
  }

  /** The same heights over `part`, a square inside the ground tile `tile` this relief is over. */
  narrowed(part: Tile, tile: Tile): GroundRelief {
    const inner = GroundRelief.placement(part, tile);
    return new GroundRelief(this.terrain, this.originX + inner.originX * this.scale, this.originY + inner.originY * this.scale, this.scale * inner.scale, this.strength, this.occlusion);
  }

  /** Where a tile lies in the terrain tile `source` over it. */
  static placement(tile: Tile, source: Tile): { originX: number; originY: number; scale: number } {
    const depth = Math.max(0, tile.z - source.z);
    const span = 2 ** depth;
    return {
      originX: Math.fround((tile.x - source.x * span) / span),
      originY: Math.fround((tile.y - source.y * span) / span),
      scale: Math.fround(1 / span),
    };
  }
}
