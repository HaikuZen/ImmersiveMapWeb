// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `SurfaceLabelTests` (the selection, scale and depth
// parts): which copy of a name painted on the map draws, at which zooms, how
// large it is, and where it sits in the ground's depth band.

import { describe, expect, test } from "vitest";
import { GlobeSurfaceDepthRank, RoadRankDepth } from "../../tile/drawers/depth-rank.ts";
import type { PreparedLabelTextStyle, SurfaceLabelPlacement, SurfaceLabelRecord } from "../../tile/store/prepared-labels.ts";
import { SurfaceLabelDepth, SurfaceLabelScale, SurfaceLabelSelection, surfaceLabelVisibleAtZoom, type SurfaceLabelSource } from "./surface-label-selection.ts";

const placement: SurfaceLabelPlacement = { referenceZoom: 3, minimumZoom: 2.5, maximumZoom: 5.5, letterSpacingEm: 0.15 };

function record(key: number, vertexStart = 0): SurfaceLabelRecord {
  return { key: String(key), style: { key: 73 } as PreparedLabelTextStyle, placement, vertexStart, vertexCount: 6 };
}

function source(keys: number[], tileZoom: number, worldWrap = 0): SurfaceLabelSource {
  return { labels: keys.map((key) => record(key)), tileZoom, worldWrap };
}

describe("SurfaceLabelSelection", () => {
  // The same name rides every tile zoom from the one it ships at: the finest
  // source that carries it draws it, once.
  test("the finest source draws a name", () => {
    const items = SurfaceLabelSelection.select([source([1], 3), source([1, 2], 4)], 4);
    expect(items.map((item) => item.key)).toEqual(["1", "2"]);
    expect(items.map((item) => item.sourceIndex)).toEqual([1, 1]);
    expect(items.map((item) => item.labelIndex)).toEqual([0, 1]);
  });

  test("sources of one zoom keep their order", () => {
    const items = SurfaceLabelSelection.select([source([1], 3), source([1, 2], 3)], 3);
    expect(items.map((item) => [item.sourceIndex, item.key])).toEqual([
      [0, "1"],
      [1, "2"],
    ]);
  });

  // Each copy of the flat world draws its own copy of the name.
  test("every world copy draws its own name", () => {
    expect(SurfaceLabelSelection.select([source([1], 3, 0), source([1], 3, 1)], 3)).toHaveLength(2);
  });

  // A name shows whole inside its zooms and not at all outside them.
  test("a name shows only at its zooms", () => {
    const sources = [source([1], 3)];
    expect(SurfaceLabelSelection.select(sources, 2.4)).toHaveLength(0);
    expect(SurfaceLabelSelection.select(sources, 2.5)).toHaveLength(1);
    expect(SurfaceLabelSelection.select(sources, 5.4)).toHaveLength(1);
    expect(SurfaceLabelSelection.select(sources, 5.5)).toHaveLength(0);
  });

  test("a missing bound is no bound", () => {
    const open: SurfaceLabelPlacement = { referenceZoom: 3, minimumZoom: null, maximumZoom: null, letterSpacingEm: 0 };
    expect(surfaceLabelVisibleAtZoom(open, -100)).toBe(true);
    expect(surfaceLabelVisibleAtZoom(open, 100)).toBe(true);
  });
});

describe("SurfaceLabelScale", () => {
  // The map's scale follows the viewport's height: a tile at its own zoom
  // spans its world size over the height the camera sees at distance 1.
  test("a tile spans the share of the height the camera sees", () => {
    expect(SurfaceLabelScale.tileScreenPoints(800, 2 * Math.tan(Math.PI / 8))).toBeCloseTo(800, 9);
  });

  // At the reference zoom the text spans its point size, and every zoom of
  // the tile deeper doubles the tile units a point takes.
  test("the text spans its point size at the reference zoom", () => {
    expect(SurfaceLabelScale.tileUnitsPerPoint(3, 3, 1024)).toBe(4);
    expect(SurfaceLabelScale.tileUnitsPerPoint(4, 3, 1024)).toBe(8);
    expect(SurfaceLabelScale.tileUnitsPerPoint(2, 3, 1024)).toBe(2);
  });

  test("a tile that spans nothing gives no scale", () => {
    expect(SurfaceLabelScale.tileUnitsPerPoint(3, 3, 0)).toBe(0);
    expect(SurfaceLabelScale.tileUnitsPerPoint(3, 3, Number.NaN)).toBe(0);
  });
});

describe("SurfaceLabelDepth", () => {
  test("the labels lie over the ground and the roads, under the buildings", () => {
    const step = GlobeSurfaceDepthRank.layerDepthStep;
    expect(SurfaceLabelDepth.depth).toBeCloseTo(1 - GlobeSurfaceDepthRank.surfaceLabelsRank * step, 12);
    const nearestRoad = 1 - RoadRankDepth.depthOffset(RoadRankDepth.bandCount);
    expect(SurfaceLabelDepth.depth, "nearer than every road rank").toBeLessThan(nearestRoad);
    expect(SurfaceLabelDepth.depth, "nearer than the app's layers").toBeLessThan(1 - GlobeSurfaceDepthRank.appLayersRank * step);
    expect(SurfaceLabelDepth.depth, "farther than the buildings").toBeGreaterThan(1 - GlobeSurfaceDepthRank.realGeometryRank * step);
  });
});
