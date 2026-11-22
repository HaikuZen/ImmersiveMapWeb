// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** Content identity of a vector tile. */
export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The string key a tile is stored under in maps and sets. */
export function tileKey(tile: Tile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

export function tileFromKey(key: string): Tile {
  const [z, x, y] = key.split("/").map(Number);
  return { z: z!, x: x!, y: y! };
}

/** Whether `tile`, of a lower zoom, contains `other`. */
export function tileCovers(tile: Tile, other: Tile): boolean {
  if (tile.z >= other.z) return false;
  const scale = 1 << (other.z - tile.z);
  return other.x >= tile.x * scale && other.x <= (tile.x + 1) * scale - 1 && other.y >= tile.y * scale && other.y <= (tile.y + 1) * scale - 1;
}

export function tileParentAt(tile: Tile, zoom: number): Tile | undefined {
  if (tile.z < zoom || zoom < 0) return undefined;
  const d = tile.z - zoom;
  return { x: tile.x >> d, y: tile.y >> d, z: zoom };
}
