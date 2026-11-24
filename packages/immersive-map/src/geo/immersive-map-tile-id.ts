// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "./geo-coordinate.ts";
import type { ImmersiveMapGeoBounds } from "./immersive-map-geo-bounds.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

/**
 * A tile of the XYZ scheme the web's maps share, the Swift
 * `ImmersiveMapTileID`: Web Mercator, `zoom` halving the tile's side at each
 * step, `x` counted east from the antimeridian and `y` south from the north
 * edge of the map. It names a square of the ground, not a tile of the map's
 * own archive, so a tile of any zoom can be named, whatever zooms the
 * archive holds. Plain data: two tiles are the same tile when their three
 * numbers are (`ImmersiveMapTileID.equals`, or their `key`).
 */
export interface ImmersiveMapTileID {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

const degrees = 180 / Math.PI;

export const ImmersiveMapTileID = {
  /** The deepest zoom a tile is named at. */
  maximumZoom: 24,

  /**
   * A tile by its numbers. The zoom is clamped to `0...maximumZoom`, the x
   * wraps round the antimeridian (a column past the last is the first
   * again) and the y is clamped to the map.
   */
  make(zoom: number, x: number, y: number): ImmersiveMapTileID {
    const z = Math.min(Math.max(Math.trunc(zoom) || 0, 0), ImmersiveMapTileID.maximumZoom);
    const count = 2 ** z;
    const wrapped = (Math.trunc(x) || 0) % count;
    return { zoom: z, x: wrapped < 0 ? wrapped + count : wrapped, y: Math.min(Math.max(Math.trunc(y) || 0, 0), count - 1) };
  },

  /** The tile of `zoom` that holds the coordinate. A latitude past the map's edge (about 85.05 degrees) gives the tile of the edge. */
  containing(coordinate: GeoCoordinate, zoom: number): ImmersiveMapTileID {
    const world = ImmersiveMapProjection.worldMercator(coordinate.latitude / degrees, coordinate.longitude / degrees);
    return ImmersiveMapTileID.containingWorld(world[0], world[1], zoom);
  },

  /** The tile of `zoom` that holds a point of the normalized world (x east, y south, 0 to 1). */
  containingWorld(worldX: number, worldY: number, zoom: number): ImmersiveMapTileID {
    const z = Math.min(Math.max(Math.trunc(zoom) || 0, 0), ImmersiveMapTileID.maximumZoom);
    const count = 2 ** z;
    const x = ImmersiveMapProjection.wrapNormalizedWorldX(worldX);
    const y = ImmersiveMapProjection.clampNormalizedWorldY(worldY);
    return { zoom: z, x: Math.min(Math.floor(x * count), count - 1), y: Math.min(Math.floor(y * count), count - 1) };
  },

  /** The tile's box in degrees. */
  bounds(tile: ImmersiveMapTileID): ImmersiveMapGeoBounds {
    const count = 2 ** tile.zoom;
    const west = (tile.x / count) * 360 - 180;
    const east = ((tile.x + 1) / count) * 360 - 180;
    const north = ImmersiveMapProjection.latitudeFromNormalizedWorldY(tile.y / count) * degrees;
    const south = ImmersiveMapProjection.latitudeFromNormalizedWorldY((tile.y + 1) / count) * degrees;
    return { southWest: { latitude: south, longitude: west }, northEast: { latitude: north, longitude: east } };
  },

  /** The middle of the tile's square on the map, which is north of the middle of its latitudes. */
  center(tile: ImmersiveMapTileID): GeoCoordinate {
    const count = 2 ** tile.zoom;
    return { latitude: ImmersiveMapProjection.latitudeFromNormalizedWorldY((tile.y + 0.5) / count) * degrees, longitude: ((tile.x + 0.5) / count) * 360 - 180 };
  },

  /** The tile one zoom up that holds this one, null at zoom 0. */
  parent(tile: ImmersiveMapTileID): ImmersiveMapTileID | null {
    return tile.zoom > 0 ? { zoom: tile.zoom - 1, x: tile.x >> 1, y: tile.y >> 1 } : null;
  },

  /** The four tiles one zoom down, west to east and north to south, none at `maximumZoom`. */
  children(tile: ImmersiveMapTileID): ImmersiveMapTileID[] {
    if (tile.zoom >= ImmersiveMapTileID.maximumZoom) return [];
    const z = tile.zoom + 1;
    const x = tile.x * 2;
    const y = tile.y * 2;
    return [
      { zoom: z, x, y },
      { zoom: z, x: x + 1, y },
      { zoom: z, x, y: y + 1 },
      { zoom: z, x: x + 1, y: y + 1 },
    ];
  },

  equals(a: ImmersiveMapTileID, b: ImmersiveMapTileID): boolean {
    return a.zoom === b.zoom && a.x === b.x && a.y === b.y;
  },

  /** The tile as `zoom/x/y`: a key for a `Map` or a `Set`. */
  key(tile: ImmersiveMapTileID): string {
    return `${tile.zoom}/${tile.x}/${tile.y}`;
  },

  /** The tile of a `zoom/x/y` key, null for a text that is none. */
  fromKey(key: string): ImmersiveMapTileID | null {
    const parts = key.split("/");
    if (parts.length !== 3 || !parts.every((part) => /^-?\d+$/.test(part))) return null;
    return ImmersiveMapTileID.make(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  },

  /**
   * The tile in one number, exact in a double: five bits of zoom over twice
   * twenty-four of x and y. What the grid keys its tiles by.
   * @internal
   */
  number(tile: ImmersiveMapTileID): number {
    return tileNumber(tile.zoom, tile.x, tile.y);
  },
} as const;

/** @internal `ImmersiveMapTileID.number` of the three numbers. */
export function tileNumber(zoom: number, x: number, y: number): number {
  return (zoom * 16_777_216 + x) * 16_777_216 + y;
}
