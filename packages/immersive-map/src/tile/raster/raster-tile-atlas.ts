// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The windows of the bake atlas (the Swift `RasterTileRenderSubsystem.prepareGPU`):
 * the tiles drawn again in a frame are drawn in one pass, each in its own
 * window of one shared atlas, a square grid of cells as large as the
 * largest texture, then copied from there into their textures.
 *
 * WebGPU caps a texture's side (`maxTextureDimension2D`, 8192 by default),
 * so the windows go in pages of at most that side, drawn and copied one
 * after the other through the same atlas. The Swift engine draws one page
 * of any size: a frame within the cap gives the same single page here.
 */

export interface RasterAtlasWindow {
  /** The index of the texture in the sizes asked for. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface RasterAtlasPage {
  /** The atlas side the page needs. */
  readonly width: number;
  readonly height: number;
  readonly windows: readonly RasterAtlasWindow[];
}

/**
 * The pages and windows of textures of `sizes` a side, in order: each page
 * a grid of `ceil(sqrt(n))` columns of cells of the largest size, no side
 * past `maximumSide`. A size past `maximumSide` itself takes the whole side.
 */
export function rasterAtlasPages(sizes: readonly number[], maximumSide: number): RasterAtlasPage[] {
  if (sizes.length === 0) return [];
  const cell = Math.min(
    sizes.reduce((largest, size) => Math.max(largest, size), 0),
    maximumSide,
  );
  const perSide = Math.max(1, Math.floor(maximumSide / cell));
  const perPage = perSide * perSide;
  const pages: RasterAtlasPage[] = [];
  for (let first = 0; first < sizes.length; first += perPage) {
    const count = Math.min(perPage, sizes.length - first);
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const windows: RasterAtlasWindow[] = [];
    for (let slot = 0; slot < count; slot++) {
      windows.push({ index: first + slot, x: (slot % columns) * cell, y: Math.floor(slot / columns) * cell, size: Math.min(sizes[first + slot]!, cell) });
    }
    pages.push({ width: columns * cell, height: rows * cell, windows });
  }
  return pages;
}

/**
 * The atlas side to make for a need of `width` by `height`: `undefined`
 * when the current one fits, else grown to the larger of each side, so the
 * atlas only grows to the largest frame's need.
 */
export function grownRasterAtlasSize(
  current: { readonly width: number; readonly height: number } | undefined,
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  if (current && current.width >= width && current.height >= height) return undefined;
  return { width: Math.max(width, current?.width ?? 0), height: Math.max(height, current?.height ?? 0) };
}
