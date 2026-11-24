// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { layOutTileGridText, makeTileGridAtlas, TILE_GRID_ATLAS_GLYPH_FLOATS, type TileGridAtlasSource } from "./tile-grid-atlas.ts";
import { TileGridFrameLayout, TileGridPipeline, writeTileGridFrameUniform } from "./tile-grid-pipeline.ts";
import tileGridSource from "./shaders/tile-grid.wgsl?raw";

const source: TileGridAtlasSource = {
  atlas: { distanceRange: 24, size: 64, width: 100, height: 200 },
  metrics: { emSize: 1 },
  glyphs: [
    { unicode: 32, advance: 0.25 },
    { unicode: 49, advance: 0.5, planeBounds: { left: 0.1, bottom: -0.1, right: 0.4, top: 0.7 }, atlasBounds: { left: 10, bottom: 20, right: 60, top: 100 } },
    { unicode: 47, advance: 0.3, planeBounds: { left: 0, bottom: -0.2, right: 0.3, top: 0.8 }, atlasBounds: { left: 0, bottom: 0, right: 10, top: 50 } },
  ],
};

describe("the tile grid's font", () => {
  const atlas = makeTileGridAtlas(source);

  test("a glyph of the table: its box about the pen, and its place in the atlas with v down", () => {
    const one = atlas.indices.get(49)!;
    const glyph = [...atlas.table.subarray(one * TILE_GRID_ATLAS_GLYPH_FLOATS, (one + 1) * TILE_GRID_ATLAS_GLYPH_FLOATS)];
    [0.1, -0.1, 0.4, 0.7, 0.1, 0.9, 0.6, 0.5].forEach((value, index) => expect(glyph[index]).toBeCloseTo(value, 6));
    expect(atlas.drawn[atlas.indices.get(32)!]).toBe(0);
    expect([atlas.distanceRange, atlas.emTexels]).toEqual([24, 64]);
  });

  test("a line is laid out round its own middle", () => {
    const layout = layOutTileGridText(atlas, "1/1")!;
    // From the first glyph's left edge (0.1) to the last one's right (0.8 + 0.4).
    expect(layout.widthEm).toBeCloseTo(1.1, 6);
    expect(layout.heightEm).toBeCloseTo(1.0, 6);
    const floats = new Float32Array(layout.records.buffer);
    expect([...layout.records].filter((_, index) => index % 4 === 0).map((word) => word >> 16)).toEqual([1, 2, 1]);
    // The pens, from the middle at x 0.65 and y 0.3 above the baseline.
    expect(floats[1]).toBeCloseTo(-0.65, 6);
    expect(floats[5]).toBeCloseTo(-0.15, 6);
    expect(floats[9]).toBeCloseTo(0.15, 6);
    expect(floats[2]).toBeCloseTo(-0.3, 6);
  });

  test("a space and a character the atlas lacks only advance, and a text of them draws nothing", () => {
    const spaced = layOutTileGridText(atlas, "1 1")!;
    expect(new Float32Array(spaced.records.buffer)[5]! - new Float32Array(spaced.records.buffer)[1]!).toBeCloseTo(0.75, 6);
    const unknown = layOutTileGridText(atlas, "1й1")!;
    expect(unknown.records.length).toBe(8);
    expect(layOutTileGridText(atlas, "  й")).toBeUndefined();
    expect(layOutTileGridText(atlas, "")).toBeUndefined();
  });
});

describe("TileGridPipeline", () => {
  test("a patch of every subdivision is cut from the one lattice", () => {
    expect(TileGridPipeline.latticeIndices(1)).toEqual([0, 64 * 65, 64, 64, 64 * 65, 64 * 65 + 64]);
    for (const subdivision of TileGridPipeline.subdivisions) {
      const indices = TileGridPipeline.latticeIndices(subdivision);
      expect(indices).toHaveLength(subdivision * subdivision * 6);
      expect(Math.max(...indices)).toBe(65 * 65 - 1);
    }
  });

  test("the frame's uniform is laid out as the shader reads it", () => {
    const fields = /struct TileGridFrame \{([^}]+)\}/.exec(tileGridSource)![1]!;
    const names = [...fields.matchAll(/^\s*(\w+): (\w+),/gm)].map((match) => [match[1]!, match[2]!] as const);
    let offset = 0;
    for (const [name, type] of names) {
      const size = type === "vec4f" ? 16 : type === "vec2f" ? 8 : 4;
      offset = Math.ceil(offset / Math.min(size, 16)) * Math.min(size, 16);
      const expected = (TileGridFrameLayout as Record<string, number>)[name];
      if (expected !== undefined) expect(expected, name).toBe(offset);
      offset += size;
    }
    expect(Math.ceil(offset / 16) * 16).toBe(TileGridFrameLayout.byteLength);

    const staging = new Float32Array(TileGridFrameLayout.byteLength / 4);
    const settings = ImmersiveMapSettings.default.tileGridSettings({ lineWidthPoints: 3, labelHaloWidthPoints: 2 }).tileGrid;
    writeTileGridFrameUniform(staging, settings, 2400, 1720, 2, undefined);
    expect(staging[TileGridFrameLayout.viewport / 4]).toBe(2400);
    expect(staging[TileGridFrameLayout.halfLineWidthPx / 4]).toBe(3);
    expect(staging[TileGridFrameLayout.minimumTilePx / 4]).toBe(96);
    expect(staging[TileGridFrameLayout.haloWidthPx / 4]).toBe(4);
    expect(staging[TileGridFrameLayout.labelMinimumTilePx / 4]).toBe(192);
    expect(staging[TileGridFrameLayout.depth / 4]).toBeGreaterThan(0.99);
    expect([...staging.subarray(4, 8)]).toEqual([...new Float32Array(settings.selectedFillColor)]);
  });
});
