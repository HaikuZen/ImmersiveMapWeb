// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `RoadLabelPlacerTests` (the anchor's own point, made
// by the cache) and `RoadLabelReliefPathTests` (on the relief a road label's
// path is cut where the road's ribbon is, at the grid's crossings), with the
// cache's records across a change of the tile set.

import { describe, expect, test } from "vitest";
import { makePlaceTile } from "../../tile/placement/place-tile.ts";
import type { RoadLabelAnchor, RoadLabelsMeta } from "../../tile/store/prepared-labels.ts";
import type { GpuTile } from "../../tile/store/tile-gpu.ts";
import type { LabelSourceTile } from "../base/base-label-cache.ts";
import { buildBaseLabelSourceEntries } from "../base/base-label-source-entry.ts";
import { makeTileTextLabels } from "../base/tile-text-labels.ts";
import { cutAtGrid, cutPathSegment, RoadLabelCache, roadLabelFallbackStyle } from "./road-label-cache.ts";

function anchor(segmentIndex: number, t: number, anchorOrdinal = 0): RoadLabelAnchor {
  return { pathIndex: 0, segmentIndex, t, anchorOrdinal };
}

/** A tile of one road label on `path`, two glyphs, at `anchors`. */
function roadTile(x: number, y: number, z: number, path: [number, number][], anchors: RoadLabelAnchor[]): LabelSourceTile {
  const road: RoadLabelsMeta = {
    pathInputs: path,
    pathRanges: [{ start: 0, count: path.length, labelIndex: 0 }],
    pathLabels: [{ text: "Main", key: "77" }],
    labelStyle: null,
    glyphBounds: [
      [0, 10, -2, 8],
      [10, 24, -4, 8],
    ],
    glyphBoundRanges: [{ start: 0, count: 2 }],
    sizes: [[24, 12]],
    anchorRanges: [{ start: 0, count: anchors.length }],
    anchors,
  };
  const labels = { placementInputs: [], glyphRunStyles: [], poiIconRunStyles: [], routeShieldRunStyles: [], road };
  const gpu = { meta: { labels }, labels: { roadGlyphs: { vertexOffset: 0, vertexCount: 12 } } } as unknown as GpuTile;
  return { tile: { x, y, z }, gpu, textLabels: makeTileTextLabels(labels) };
}

function entries(...tiles: LabelSourceTile[]) {
  return buildBaseLabelSourceEntries(tiles.map((tile) => makePlaceTile(tile, { tile: tile.tile, worldWrap: 0 })));
}

/** The anchor point the record puts after its paths' points, as tile uv. */
function anchorPoint(cache: RoadLabelCache, instance = 0): [number, number] {
  const geometry = cache.orderedRecords[0]!.geometry;
  const index = geometry.anchors[instance * 3 + 2]!;
  return [geometry.pathPoints[index * 2]!, geometry.pathPoints[index * 2 + 1]!];
}

describe("RoadLabelCache anchor points", () => {
  test("the anchor point interpolates on its segment", () => {
    const cache = new RoadLabelCache();
    cache.synchronize(entries(roadTile(1, 2, 3, [[0, 0], [0.5, 0.1], [0.9, 0.7]], [anchor(1, 0.25)])));
    const [u, v] = anchorPoint(cache);
    expect(u).toBeCloseTo(0.6, 6);
    expect(v).toBeCloseTo(0.25, 6);
    expect(cache.orderedRecords[0]!.geometry.anchors[2], "after the path's three points").toBe(3);
  });

  test("the anchor point clamps the segment index and t", () => {
    const cache = new RoadLabelCache();
    cache.synchronize(entries(roadTile(0, 0, 1, [[0.2, 0.2], [0.4, 0.2]], [anchor(7, 1.5)])));
    const [u, v] = anchorPoint(cache);
    expect(u).toBeCloseTo(0.4, 6);
    expect(v).toBeCloseTo(0.2, 6);
  });
});

describe("RoadLabelCache records", () => {
  test("a record lays its instances' glyphs out from the label's bounds", () => {
    const cache = new RoadLabelCache();
    const change = cache.synchronize(entries(roadTile(0, 0, 1, [[0.1, 0.5], [0.9, 0.5]], [anchor(0, 0.25, 0), anchor(0, 0.75, 1)])));
    const record = cache.orderedRecords[0]!;
    expect(change.count).toBe(2);
    expect(cache.instanceCount).toBe(2);
    expect(record.labelStyle, "a tile without a style of its own").toBe(roadLabelFallbackStyle);
    expect(record.glyphCount).toBe(4);
    expect(record.hasRenderableGlyphs).toBe(true);
    expect(Array.from(record.geometry.instanceGlyphRanges)).toEqual([0, 2, 2, 4]);
    // Per glyph: its centre, the label's vertical centre, the label's width, the least path length.
    expect(Array.from(record.geometry.glyphs.subarray(0, 8))).toEqual([5, 2, 24, 24, 17, 2, 24, 24]);
    expect(Array.from(record.geometry.glyphHalfSizes.subarray(0, 4))).toEqual([5, 5, 7, 6]);
    expect(Array.from(record.instanceLabelSizes)).toEqual([24, 12, 24, 12]);
    expect(Array.from(record.instanceAnchorOrdinals)).toEqual([0, 1]);
    expect(record.instanceKeys[0], "two anchors are two instances").not.toBe(record.instanceKeys[1]);
  });

  test("an instance key is stable across caches and holds its tile", () => {
    const first = new RoadLabelCache();
    const second = new RoadLabelCache();
    const path: [number, number][] = [
      [0.1, 0.5],
      [0.9, 0.5],
    ];
    first.synchronize(entries(roadTile(0, 0, 1, path, [anchor(0, 0.5)])));
    second.synchronize(entries(roadTile(0, 0, 1, path, [anchor(0, 0.5)])));
    const elsewhere = new RoadLabelCache();
    elsewhere.synchronize(entries(roadTile(1, 0, 1, path, [anchor(0, 0.5)])));
    expect(first.orderedRecords[0]!.instanceKeys[0]).toBe(second.orderedRecords[0]!.instanceKeys[0]);
    expect(first.orderedRecords[0]!.instanceKeys[0]).not.toBe(elsewhere.orderedRecords[0]!.instanceKeys[0]);
  });

  test("a tile that stays keeps its record and its run moves", () => {
    const path: [number, number][] = [
      [0.1, 0.5],
      [0.9, 0.5],
    ];
    const a = roadTile(0, 0, 2, path, [anchor(0, 0.5)]);
    const b = roadTile(1, 0, 2, path, [anchor(0, 0.25, 0), anchor(0, 0.75, 1)]);
    const cache = new RoadLabelCache();
    cache.synchronize(entries(a, b));
    const record = cache.orderedRecords[1]!;
    expect(record.instanceStart).toBe(1);
    const change = cache.synchronize(entries(b));
    expect(cache.orderedRecords[0]).toBe(record);
    expect(record.instanceStart).toBe(0);
    expect(change.count).toBe(2);
    expect(change.moves).toEqual([{ oldStart: 1, newStart: 0, count: 2 }]);
  });

  test("a path of no length or with no anchors labels nothing", () => {
    const cache = new RoadLabelCache();
    cache.synchronize(entries(roadTile(0, 0, 1, [[0.5, 0.5], [0.5, 0.5]], [anchor(0, 0.5)]), roadTile(1, 0, 1, [[0.1, 0.5], [0.9, 0.5]], [])));
    expect(cache.instanceCount).toBe(0);
    expect(cache.orderedRecords.map((record) => record.glyphCount)).toEqual([0, 0]);
  });

  test("on the relief a record's path is cut at the grid and its anchor follows", () => {
    // A 1024 unit step is a quarter of the tile.
    const cache = new RoadLabelCache(() => 1024);
    cache.synchronize(entries(roadTile(0, 0, 1, [[0.1, 0.5], [0.9, 0.5]], [anchor(0, 0.6)])));
    const geometry = cache.orderedRecords[0]!.geometry;
    expect(Array.from(geometry.pathRanges)).toEqual([0, 5]);
    expect(geometry.anchors[1], "x 0.58 lies between 0.5 and 0.75").toBe(2);
  });
});

/** A path of points (x, y) as the cache's flat uv numbers. */
function flat(...points: [number, number][]): number[] {
  return points.flat();
}

function pairs(points: readonly number[]): [number, number][] {
  return Array.from({ length: points.length / 2 }, (_, index): [number, number] => [points[index * 2]!, points[index * 2 + 1]!]);
}

describe("cutAtGrid", () => {
  // A segment takes a point at every grid line it crosses, in its own order,
  // and keeps its ends.
  test("a path is cut at every grid crossing", () => {
    const crossed = pairs(cutAtGrid(flat([0.1, 0.1], [0.9, 0.6]), 0.25).points);
    expect(crossed[0]).toEqual([0.1, 0.1]);
    expect(crossed[crossed.length - 1]).toEqual([0.9, 0.6]);
    // x = 0.25, 0.5, 0.75 and y = 0.25, 0.5: five crossings, in order.
    expect(crossed).toHaveLength(7);
    for (let index = 1; index < crossed.length; index++) {
      expect(crossed[index - 1]![0], "along the segment").toBeLessThan(crossed[index]![0]);
    }
  });

  // An anchor moves onto the cut segment its place falls in, and a path that
  // crosses no line is left whole.
  test("an anchor lands on its cut segment", () => {
    const cut = cutAtGrid(flat([0.1, 0.5], [0.9, 0.5], [0.9, 0.55]), 0.25);
    // The first segment cut at x = 0.25, 0.5 and 0.75, the second (y up from
    // 0.5, a grid line, to 0.55) not at all.
    expect(cut.points).toHaveLength(12);
    expect(cut.firstSegments).toEqual([0, 4]);
    expect(cutPathSegment(cut, anchor(0, 0.6)), "x 0.58 lies between 0.5 and 0.75").toBe(2);
    expect(cutPathSegment(cut, anchor(1, 0.5))).toBe(4);
    const whole = cutAtGrid(flat([0.3, 0.3], [0.4, 0.4]), 0.25);
    expect(whole.points).toHaveLength(4);
    expect(cutPathSegment(whole, anchor(0, 0.5))).toBe(0);
  });

  test("no grid leaves the path as it came", () => {
    const cut = cutAtGrid(flat([0.1, 0.1], [0.9, 0.6]), 0);
    expect(cut.points).toEqual([0.1, 0.1, 0.9, 0.6]);
    expect(cut.firstSegments).toEqual([0]);
    expect(cut.cuts).toEqual([[]]);
  });
});
