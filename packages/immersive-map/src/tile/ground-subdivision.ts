// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The sphere grid step of a tile zoom, mirrored from the Wasm parser's
 * `ground_subdivider::step_for_tile_zoom` (the Swift
 * `GroundGeometrySubdivider.step`): a tile with a step is drawn on the sphere
 * and bakes its ribbons, a tile without one (zoom 8 and deeper) defers them.
 */
export function step(tileZoom: number): number | undefined {
  if (tileZoom <= 1) return 64;
  if (tileZoom <= 3) return 128;
  if (tileZoom <= 5) return 256;
  if (tileZoom <= 7) return 512;
  return undefined;
}
