// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { makePlaceTile } from "../placement/place-tile.ts";
import { GroundStyleRunFlag, type GroundStyleRun } from "../store/tile-gpu.ts";
import { rasterBakeSignature, rasterSources } from "./raster-tile-sources.ts";

const resident = (z: number, x: number, y: number) => ({ tile: { z, x, y } });
const raster = (size: number) => ({ rules: { drawsLines: false, drawsLabels: false, raster: { size } } });

describe("rasterSources", () => {
  test("no raster placement, no source", () => {
    expect(rasterSources([makePlaceTile(resident(14, 1, 2), { tile: { z: 14, x: 1, y: 2 }, worldWrap: 0 })])).toEqual([]);
  });

  test("a tile in several raster slots is one source of the largest size, drawn once per wrap copy, finest first", () => {
    const coarse = resident(8, 3, 3);
    const fine = resident(10, 12, 12);
    const sources = rasterSources([
      makePlaceTile(coarse, { tile: { z: 9, x: 6, y: 6 }, worldWrap: 0 }, raster(64)),
      makePlaceTile(coarse, { tile: { z: 9, x: 7, y: 6 }, worldWrap: 0 }, { ...raster(128), terrain: { z: 8, x: 3, y: 3 } }),
      makePlaceTile(coarse, { tile: { z: 9, x: 6, y: 6 }, worldWrap: -1 }, raster(64)),
      makePlaceTile(fine, { tile: { z: 10, x: 12, y: 12 }, worldWrap: 0 }, raster(64)),
    ]);
    expect(sources.map((s) => s.key)).toEqual(["10/12/12", "8/3/3"]);
    const [, wide] = sources;
    expect(wide!.resident).toBe(coarse);
    expect(wide!.size).toBe(128);
    expect(wide!.placements).toEqual([
      { worldWrap: 0, terrain: { z: 8, x: 3, y: 3 }, displacement: { z: 8, x: 3, y: 3 } },
      { worldWrap: -1, terrain: undefined, displacement: undefined },
    ]);
  });

  test("a tile drawn as geometry anywhere draws no texture", () => {
    const tile = resident(9, 1, 1);
    const sources = rasterSources([
      makePlaceTile(tile, { tile: { z: 9, x: 1, y: 1 }, worldWrap: 0 }),
      makePlaceTile(tile, { tile: { z: 10, x: 2, y: 2 }, worldWrap: 0 }, raster(64)),
    ]);
    expect(sources).toEqual([]);
  });
});

describe("rasterBakeSignature", () => {
  const run = (zoomFade: [number, number], flags = 0): GroundStyleRun => ({ indexStart: 0, indexCount: 3, zoomFade, flags });

  test("equal fade steps give equal signatures, a moved step another", () => {
    const runs = [run([5, 6]), run([0, 0])];
    expect(rasterBakeSignature(runs, 5.5)).toBe(rasterBakeSignature(runs, 5.5 + 0.2 / 64));
    expect(rasterBakeSignature(runs, 5.5)).not.toBe(rasterBakeSignature(runs, 5.5 + 1 / 64));
    // Past the fade every zoom draws the same texture.
    expect(rasterBakeSignature(runs, 7)).toBe(rasterBakeSignature(runs, 12));
  });

  test("the line runs are never in a texture", () => {
    const fills = [run([0, 0])];
    const withLines = [...fills, run([5, 6], GroundStyleRunFlag.linesClass)];
    expect(rasterBakeSignature(withLines, 5.2)).toBe(rasterBakeSignature(fills, 5.2));
    expect(rasterBakeSignature(withLines, 5.2)).toBe(rasterBakeSignature(withLines, 5.8));
  });
});
