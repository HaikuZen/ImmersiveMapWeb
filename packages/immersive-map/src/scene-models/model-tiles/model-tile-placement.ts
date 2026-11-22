// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Which model tiles a frame wants and where one stands, the static part of
 * the Swift `ModelTileRenderSubsystem` (`wantedTiles`, `placement`).
 *
 * What is in view is the map's own answer: the frame's coverage lists the
 * map tiles it draws, and a model tile is wanted when a map tile of its
 * zoom or deeper lies in it, so the models follow the camera exactly as the
 * map does. The tiles next to those are wanted too: a model reaches over
 * its tile's edge, and its shadow further still.
 */

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import { type VisibleTile, visibleTileKey } from "../../tile/placement/place-tile.ts";
import { ModelTileStore } from "./model-tile-store.ts";

/** The tiles around a tile in view that are wanted with it, in tiles. */
export const modelTileNeighbourRing = 1;

/** The units of tile space along a tile's edge, the map's own extent (`ModelTileContents.tileExtent`). */
export const modelTileExtent = 4096;

/**
 * The model tiles a frame wants, nearest first: the tile over each map tile
 * the frame draws at the model tiles' zoom or deeper, in the coverage's own
 * order (finest first, which is nearest first), and after them the ring of
 * tiles around those. A map tile coarser than a model tile is far from the
 * camera, and its models are not asked for. A tile keeps the copy of the
 * world its map tile draws in, and a neighbour across the world's seam is
 * in the copy next to it.
 */
export function wantedModelTiles(visibleTiles: readonly VisibleTile[]): VisibleTile[] {
  const zoom = ModelTileStore.tileZoom;
  const side = 2 ** zoom;
  const wanted: VisibleTile[] = [];
  const seen = new Set<string>();
  const add = (tile: VisibleTile): void => {
    const key = visibleTileKey(tile);
    if (seen.has(key)) return;
    seen.add(key);
    wanted.push(tile);
  };
  for (const visible of visibleTiles) {
    if (visible.tile.z < zoom) continue;
    const shift = visible.tile.z - zoom;
    add({ tile: { x: visible.tile.x >> shift, y: visible.tile.y >> shift, z: zoom }, worldWrap: visible.worldWrap });
  }
  const centres = wanted.length;
  const ring = modelTileNeighbourRing;
  for (let i = 0; i < centres; i++) {
    const centre = wanted[i]!;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (dx === 0 && dy === 0) continue;
        const y = centre.tile.y + dy;
        if (y < 0 || y >= side) continue;
        // The world wraps in x: past its edge the neighbour is the first column of the next copy.
        let x = centre.tile.x + dx;
        let worldWrap = centre.worldWrap;
        if (x < 0) {
          x += side;
          worldWrap -= 1;
        } else if (x >= side) {
          x -= side;
          worldWrap += 1;
        }
        add({ tile: { x, y, z: zoom }, worldWrap });
      }
    }
  }
  return wanted;
}

/**
 * Where a model tile stands in the frame's flat world: the tile's south-west
 * corner, the world units a unit of tile space takes, and the column-major
 * matrix of the two. The same placement the map's own buildings of the
 * tile take (`BuildingExtrusionSubsystem`).
 */
export function modelTilePlacement(
  tile: { readonly x: number; readonly y: number; readonly z: number },
  worldWrap: number,
  flatRenderState: { readonly pan: Vec2; readonly renderMapSize: number },
): { origin: [number, number, number]; scale: number; modelMatrix: Float64Array } {
  const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
  const scale = size / modelTileExtent;
  const modelMatrix = new Float64Array(16);
  modelMatrix[0] = scale;
  modelMatrix[5] = scale;
  modelMatrix[10] = scale;
  modelMatrix[12] = ox;
  modelMatrix[13] = oy;
  modelMatrix[15] = 1;
  return { origin: [ox, oy, 0], scale, modelMatrix };
}
