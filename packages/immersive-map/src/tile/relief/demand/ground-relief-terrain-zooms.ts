// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Tile, tileParentAt } from "../../tile.ts";
import type { FlatRingBand } from "../../visibility/flat-ring-rules.ts";

/**
 * Which terrain tiles the ground reads this frame, a port of the Swift
 * `GroundReliefTerrainZooms`: the zoom each band of the frame's ring rules
 * reads its terrain at (`FlatRingRule.terrainZoomDrop`, resolved into
 * `FlatRingBand.terrainZoom`), and the map the camera flies over
 * (`GroundReliefSettings.cameraTerrainZoom`). Made by the store from the
 * frame's bands and asked by every draw that reads the terrain and by the
 * frame's demand, so what is drawn and what is loaded agree.
 *
 * The terrain is the ring's, not the tile's: whatever stands in a ring's
 * slot, the tile itself or a stand-in while it loads, is raised by the same
 * terrain, so a tile landing changes the fills and never the ground's
 * shape. A terrain tile finer than the ground tile cannot raise it, so a
 * coarser tile reads the terrain of its own address instead.
 */
export class GroundReliefTerrainZooms {
  /** The zoom of the camera's map. */
  readonly cameraZoom: number;
  /** The finest zoom the ground's vertices rise by (`GroundReliefSettings.displacementMaximumZoom`). */
  readonly displacementMaximumZoom: number;
  /** The terrain zoom by target zoom, the frame's bands': where two bands share a zoom, the nearer one's. */
  readonly terrainZoomByTargetZoom: ReadonlyMap<number, number>;

  constructor(cameraZoom: number, displacementMaximumZoom = 10, bands: readonly FlatRingBand[] = []) {
    this.cameraZoom = Math.max(0, cameraZoom);
    this.displacementMaximumZoom = Math.max(0, displacementMaximumZoom);
    const byZoom = new Map<number, number>();
    for (const band of bands) if (!byZoom.has(band.zoom)) byZoom.set(band.zoom, Math.max(0, band.terrainZoom));
    this.terrainZoomByTargetZoom = byZoom;
  }

  /** The zoom a ring of `zoom` reads its terrain at: its band's, or its own for a zoom the frame has no band for. */
  terrainZoom(forTargetZoom: number): number {
    return this.terrainZoomByTargetZoom.get(forTargetZoom) ?? Math.max(forTargetZoom, 0);
  }

  /** The terrain tile a ground tile in a ring of `targetZoom` shades its slopes by: the ring's terrain over the tile, or the tile's own address when that is coarser. */
  terrainTile(tile: Tile, targetZoom: number): Tile {
    return tileParentAt(tile, Math.max(Math.min(this.terrainZoom(targetZoom), tile.z), 0)) ?? tile;
  }

  /** The zoom a ring of `zoom` displaces its ground by: the ring's terrain zoom, no finer than `displacementMaximumZoom`. */
  displacementZoom(forTargetZoom: number): number {
    return Math.min(this.terrainZoom(forTargetZoom), this.displacementMaximumZoom);
  }

  /** The terrain tile a ground tile in a ring of `targetZoom` displaces its grid by. */
  displacementTile(tile: Tile, targetZoom: number): Tile {
    return tileParentAt(tile, Math.max(Math.min(this.displacementZoom(targetZoom), tile.z), 0)) ?? tile;
  }

  /** The bands as the panel's status line reads them: target zoom to terrain zoom, nearest first. */
  get statusText(): string {
    return [...this.terrainZoomByTargetZoom.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([zoom, terrain]) => `z${zoom}→z${terrain}`)
      .join(" ");
  }

  equals(other: GroundReliefTerrainZooms): boolean {
    if (this.cameraZoom !== other.cameraZoom || this.displacementMaximumZoom !== other.displacementMaximumZoom) return false;
    if (this.terrainZoomByTargetZoom.size !== other.terrainZoomByTargetZoom.size) return false;
    for (const [zoom, terrain] of this.terrainZoomByTargetZoom) if (other.terrainZoomByTargetZoom.get(zoom) !== terrain) return false;
    return true;
  }
}
