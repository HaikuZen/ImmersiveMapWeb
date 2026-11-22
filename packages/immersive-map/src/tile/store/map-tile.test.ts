// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { readPreparedTileMeta } from "./map-tile.ts";
import { emptyTileLabelsMeta } from "./prepared-labels.ts";

const meta = () => ({
  kind: "arena",
  formatVersion: 3,
  spans: [{ byteOffset: 0, byteCount: 16, elementCount: 1 }],
  textRunCounts: { glyphRunCount: 0, poiIconRunCount: 0, routeShieldRunCount: 0 },
  groundStyleRuns: [],
  roadEdgeLineIndexStarts: [],
  buildingRanges: [],
  buildingAnchors: [],
  buildingQuarterIndexStarts: [],
  treeQuarterStarts: [],
  groundIsFlattened: true,
  labels: emptyTileLabelsMeta(),
});

describe("readPreparedTileMeta", () => {
  test("the parser's metadata is read with what the planners need", () => {
    const read = readPreparedTileMeta(meta());
    expect(read?.groundIsFlattened).toBe(true);
    expect(read?.spans).toHaveLength(1);
  });

  test("a tile without the flattening flag is taken as parsed in layers", () => {
    const { groundIsFlattened: _, ...rest } = meta();
    expect(readPreparedTileMeta(rest)?.groundIsFlattened).toBe(false);
  });

  test("another format or a damaged entry is unreadable", () => {
    expect(readPreparedTileMeta(undefined)).toBeUndefined();
    expect(readPreparedTileMeta({ kind: "prototype", vertexByteLength: 0, indexOffset: 0, indexCount: 0 })).toBeUndefined();
    expect(readPreparedTileMeta({ ...meta(), spans: [{ byteOffset: "0" }] })).toBeUndefined();
    expect(readPreparedTileMeta({ ...meta(), textRunCounts: undefined })).toBeUndefined();
    expect(readPreparedTileMeta({ ...meta(), groundStyleRuns: null })).toBeUndefined();
  });

  test("labels of another shape, or with run styles the arena's runs do not match, are unreadable", () => {
    expect(readPreparedTileMeta({ ...meta(), labels: undefined })).toBeUndefined();
    expect(readPreparedTileMeta({ ...meta(), labels: { text: [], road: [] } })).toBeUndefined();
    expect(readPreparedTileMeta({ ...meta(), textRunCounts: { glyphRunCount: 1, poiIconRunCount: 0, routeShieldRunCount: 0 } })).toBeUndefined();
    const labels = emptyTileLabelsMeta();
    expect(readPreparedTileMeta({ ...meta(), labels: { ...labels, road: { ...labels.road, anchors: null } } })).toBeUndefined();
  });
});
