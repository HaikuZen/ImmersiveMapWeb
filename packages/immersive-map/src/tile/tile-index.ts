// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A tile's number in the quadtree, counted zoom by zoom from the root:
 * every tile of the zooms above first, then the rows of its own zoom. A
 * number, not a string, so the per-frame lookups that key a map by tile
 * (the globe's bounds, the buildings' rises) build no key. Exact up to zoom
 * 26, where the count still fits a double's integers.
 */
export function tileIndex(x: number, y: number, z: number): number {
  const side = 2 ** z;
  return (side * side - 1) / 3 + y * side + x;
}
