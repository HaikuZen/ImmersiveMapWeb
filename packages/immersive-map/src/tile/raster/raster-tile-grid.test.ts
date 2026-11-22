// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ports the grid parts of the Swift `RasterTileTests`.

import { describe, expect, test } from "vitest";
import { makePlaceTile } from "../placement/place-tile.ts";
import { RasterTileGrid } from "./raster-tile-grid.ts";

const resident = (z: number, x: number, y: number) => ({ tile: { z, x, y } });

describe("RasterTileGrid", () => {
  /** The grid covers the tile's extent, counter-clockwise like every tile triangle, so back-face culling keeps it. */
  test("the grid covers the tile counter-clockwise", () => {
    const cells = 4;
    const { vertices, indices } = RasterTileGrid.geometry(cells);
    expect(vertices.length / 2).toBe((cells + 1) * (cells + 1));
    expect(indices.length).toBe(cells * cells * 6);
    expect([vertices[0], vertices[1]]).toEqual([0, 0]);
    expect([vertices.at(-2), vertices.at(-1)]).toEqual([4096, 4096]);
    let area = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!].map((i) => [vertices[i * 2]!, vertices[i * 2 + 1]!] as const);
      const signed = ((b![0] - a![0]) * (c![1] - a![1]) - (b![1] - a![1]) * (c![0] - a![0])) / 2;
      expect(signed, `triangle ${t / 3} is counter-clockwise`).toBeGreaterThan(0);
      area += signed;
    }
    expect(area).toBeCloseTo(4096 * 4096, 0);
  });

  /** The sphere's coarse tiles bend as their geometry does, the deep ones keep the grid a heightmap needs. */
  test("the grid follows the sphere's split", () => {
    expect(RasterTileGrid.cells(0)).toBe(64);
    expect(RasterTileGrid.cells(3)).toBe(32);
    expect(RasterTileGrid.cells(5)).toBe(RasterTileGrid.minimumCells);
    expect(RasterTileGrid.cells(14)).toBe(RasterTileGrid.minimumCells);
    for (let zoom = 0; zoom <= 22; zoom++) {
      const cells = RasterTileGrid.cells(zoom);
      expect((cells + 1) * (cells + 1)).toBeLessThanOrEqual(0xffff);
    }
  });

  /** Never past what the flattening grid reaches, 32-bit indices only past a side of 256 vertices. */
  test("the grid's index width and ceiling", () => {
    expect(RasterTileGrid.geometry(255).indices).toBeInstanceOf(Uint16Array);
    expect(RasterTileGrid.geometry(256).indices).toBeInstanceOf(Uint32Array);
    expect(RasterTileGrid.geometry(1000).indices.length, "the flattening grid's ceiling").toBe(256 * 256 * 6);
    expect(RasterTileGrid.geometry(3).indices.length, "a part of a source's grid, under the zoom's floor").toBe(3 * 3 * 6);
    expect(RasterTileGrid.geometry(0).indices.length).toBe(6);
  });

  /** No finer than its terrain has heights over it nor than a cell to two texels of its raster. */
  test("the relief grid is no finer than its terrain and raster", () => {
    const relief = (scale: number) => ({ terrain: { size: 512 }, scale });
    expect(RasterTileGrid.reliefCells(256, relief(1 / 8), 256), "the terrain's 64 heights over the tile").toBe(64);
    expect(RasterTileGrid.reliefCells(256, relief(1), 64), "two texels of a 64 raster a cell").toBe(32);
    expect(RasterTileGrid.reliefCells(16, relief(1), 128), "never finer than the flattening").toBe(16);
  });

  test("a source's raster size is its largest raster placement's, none when it is geometry anywhere", () => {
    const sizes = RasterTileGrid.rasterSizesBySource([
      makePlaceTile(resident(10, 1, 1), { tile: { z: 10, x: 1, y: 1 }, worldWrap: 0 }, { rules: { drawsLines: false, drawsLabels: false, raster: { size: 64 } } }),
      makePlaceTile(resident(10, 1, 1), { tile: { z: 10, x: 1, y: 1 }, worldWrap: 1 }, { rules: { drawsLines: false, drawsLabels: false, raster: { size: 128 } } }),
      makePlaceTile(resident(9, 0, 0), { tile: { z: 10, x: 0, y: 0 }, worldWrap: 0 }, { rules: { drawsLines: false, drawsLabels: false, raster: { size: 64 } } }),
      makePlaceTile(resident(9, 0, 0), { tile: { z: 9, x: 0, y: 0 }, worldWrap: 0 }),
    ]);
    expect([...sizes]).toEqual([["10/1/1", 128]]);
  });
});
