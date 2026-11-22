// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The CPU half of the Swift `GlobeVectorSurfaceDrawer`: which sources the
// sphere draws and in what order the ribbon cores go out.

import { describe, expect, test } from "vitest";
import type { FlatResidentTile } from "../tile/drawers/flat-map-surface-drawer.ts";
import { makePlaceTile } from "../tile/placement/place-tile.ts";
import type { SphereTilePipelines } from "../tile/pipelines/tile-sphere-pipeline.ts";
import { type GpuGeometryLayer, type GpuTile, GroundStyleRunFlag } from "../tile/store/tile-gpu.ts";
import type { Tile } from "../tile/tile.ts";
import { GlobeVectorSurfaceDrawer, highestRankFirstSpans } from "./globe-vector-surface-drawer.ts";

const layer = (runs: GpuGeometryLayer["runs"]): GpuGeometryLayer => ({
  vertexOffset: 0,
  vertexCount: 0,
  indexOffset: 0,
  indexCount: runs.reduce((n, r) => Math.max(n, r.indexStart + r.indexCount), 0),
  indexFormat: "uint16",
  styles: undefined,
  runs,
  isFlattened: false,
  roadStyles: [],
  edgeLineIndexStart: undefined,
});

const resident = (tile: Tile): FlatResidentTile => ({ tile, gpu: { ground: layer([]) } as unknown as GpuTile });

describe("GlobeVectorSurfaceDrawer", () => {
  test("the sphere draws each source once, finest first, with the union of its placements' rules", () => {
    const drawer = new GlobeVectorSurfaceDrawer({} as SphereTilePipelines);
    const coarse = resident({ x: 1, y: 1, z: 2 });
    const fine = resident({ x: 5, y: 5, z: 4 });
    const placements = [
      makePlaceTile(coarse, { tile: { x: 2, y: 2, z: 3 }, worldWrap: 0 }, { rules: { drawsLines: false, drawsLabels: false, raster: { size: 256 } as never } }),
      makePlaceTile(coarse, { tile: { x: 3, y: 2, z: 3 }, worldWrap: 1 }, { rules: { drawsLines: true, drawsLabels: true, raster: undefined } }),
      makePlaceTile(fine, { tile: { x: 5, y: 5, z: 4 }, worldWrap: 0 }, { rules: { drawsLines: false, drawsLabels: true, raster: { size: 256 } as never } }),
    ];
    const sources = drawer.sources(placements);
    expect(sources.map((s) => s.resident.tile.z)).toEqual([4, 2]);
    expect(sources[0]).toMatchObject({ drawsLines: false, drawsGround: false, stencilReference: 5 });
    expect(sources[1]).toMatchObject({ drawsLines: true, drawsGround: true, stencilReference: 3 });
  });

  test("the ribbon cores go out one run at a time, from the highest rank down", () => {
    const lines = GroundStyleRunFlag.linesClass;
    const ground = layer([
      { indexStart: 0, indexCount: 6, zoomFade: [0, 0], flags: 0 },
      { indexStart: 6, indexCount: 3, zoomFade: [0, 0], flags: lines },
      { indexStart: 9, indexCount: 0, zoomFade: [0, 0], flags: lines },
      { indexStart: 9, indexCount: 12, zoomFade: [0, 0], flags: lines },
    ]);
    expect(highestRankFirstSpans(ground, (run) => (run.flags & lines) !== 0)).toEqual([
      [9, 12],
      [6, 3],
    ]);
    expect(highestRankFirstSpans(layer([]), () => true)).toEqual([]);
  });
});
