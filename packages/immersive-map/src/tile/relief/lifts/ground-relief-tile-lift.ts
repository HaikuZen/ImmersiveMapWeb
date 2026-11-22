// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Tile } from "../../tile.ts";
import type { GroundReliefFrame } from "../frame/ground-relief-frame.ts";
import type { GroundRelief } from "./ground-relief.ts";

/**
 * How far the drawn ground of one tile rises under a point, in world units,
 * for what is placed on the ground rather than drawn as it (the labels), a
 * port of the Swift `GroundReliefTileLift`: the terrain the ground of the
 * tile rises by, the one its placement is bound to, over the frame's datum,
 * times the frame's strength, so a point sits where the ground is drawn.
 */
export class GroundReliefTileLift {
  private constructor(
    readonly relief: GroundRelief,
    readonly unitsPerMetre: number,
    readonly datumMetres: number,
  ) {}

  /** The lift of a tile's ground on the frame's relief, `undefined` on the plane, where the point stays as the tile does. */
  static make(frame: GroundReliefFrame, tile: Tile, terrain: Tile | undefined): GroundReliefTileLift | undefined {
    if (terrain === undefined) return undefined;
    const relief = frame.relief(tile, terrain);
    if (relief === undefined) return undefined;
    return new GroundReliefTileLift(relief, frame.worldUnitsPerMetre, frame.datumMetres);
  }

  /** The lift under the point at `(u, v)`, the tile's uv with v from its north edge, in world units. */
  worldUnits(u: number, v: number): number {
    return this.relief.drawnMetresAtTileUV(u, v, this.datumMetres) * this.unitsPerMetre;
  }
}
