// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The densities the debug tile grid offers (the Swift
 * `DebugTileGridDensity`): how many cells a side the tile under the camera
 * centre is divided into.
 */
export const DebugTileGridDensity = {
  options: Object.freeze([2, 4, 6, 8]) as readonly number[],
  standard: 6 as number,

  /**
   * The nearest offered density, so a stored value can never draw a grid
   * nobody can select back. A tie goes to the smaller one.
   */
  clamp(density: number): number {
    let nearest: number | undefined;
    for (const option of DebugTileGridDensity.options) {
      if (nearest === undefined || Math.abs(option - density) < Math.abs(nearest - density)) nearest = option;
    }
    return nearest ?? DebugTileGridDensity.standard;
  },
} as const;
