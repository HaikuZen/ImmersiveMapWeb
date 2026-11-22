// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { emptyTileLabelsMeta, isTileLabelsMeta, type PreparedLabelTextStyle, type TileLabelsMeta } from "./prepared-labels.ts";
import { ARENA_SPAN_ALIGNMENT, type ArenaSpan, arenaSlots, ArenaStride, readLabelSpans, type TileArenaMeta } from "./tile-gpu.ts";

const style: PreparedLabelTextStyle = {
  key: 7,
  fillColor: [0.1, 0.1, 0.1],
  strokeColor: [1, 1, 1],
  haloEm: 0.15,
  sizePoints: 12,
  weight: "thin",
  uppercased: false,
  emboldenPoints: 0.375,
  letterSpacingEm: 0,
  opacity: 1,
  haloSoftness: 0,
  isPointOfInterest: false,
  sphereFillColor: null,
  sphereStrokeColor: null,
};

/** An arena's metadata whose label slots hold these vertex counts, the other slots empty. */
function metaWith(labels: TileLabelsMeta, glyphRuns: number[], road: number, surface: number): TileArenaMeta {
  const textRunCounts = { glyphRunCount: glyphRuns.length, poiIconRunCount: 0, routeShieldRunCount: 0 };
  const slots = arenaSlots(textRunCounts);
  let run = 0;
  let offset = 0;
  const spans: ArenaSpan[] = slots.map((slot) => {
    const count = slot.kind === "glyphRunVertices" ? glyphRuns[run++]! : slot.kind === "roadLabelGlyphVertices" ? road : slot.kind === "surfaceLabelVertices" ? surface : 0;
    const span = { byteOffset: offset, byteCount: count * ArenaStride.labelVertex, elementCount: count };
    offset += Math.ceil(span.byteCount / ARENA_SPAN_ALIGNMENT) * ARENA_SPAN_ALIGNMENT;
    return span;
  });
  return {
    kind: "arena",
    formatVersion: 2,
    spans,
    textRunCounts,
    groundStyleRuns: [],
    roadEdgeLineIndexStarts: [],
    buildingRanges: [],
    buildingAnchors: [],
    buildingQuarterIndexStarts: [],
    treeQuarterStarts: [],
    labels,
  };
}

const placement = { referenceZoom: 3, minimumZoom: 2.5, maximumZoom: null, letterSpacingEm: 0.15 };

describe("the label slots of the arena", () => {
  test("each run, the road glyphs and the surface glyphs are views of their spans", () => {
    const labels = { ...emptyTileLabelsMeta(), text: { ...emptyTileLabelsMeta().text, glyphRunStyles: [style, { ...style, weight: "bold" as const }] } };
    const meta = metaWith(labels, [12, 6], 24, 0);
    const spans = readLabelSpans(meta);
    expect(spans.glyphRuns.map((r) => r.vertexCount)).toEqual([12, 6]);
    expect(spans.glyphRuns[0]!.vertexOffset % ARENA_SPAN_ALIGNMENT).toBe(0);
    expect(spans.roadGlyphs.vertexCount).toBe(24);
    expect(spans.surfaceGlyphs.vertexCount).toBe(0);
  });

  test("a surface record outside the surface glyphs, or a run without its style, is unreadable", () => {
    const record = { key: "18446744073709551615", style, placement, vertexStart: 6, vertexCount: 6 };
    const inside = { ...emptyTileLabelsMeta(), surface: [record] };
    expect(readLabelSpans(metaWith(inside, [], 0, 12)).surfaceGlyphs.vertexCount).toBe(12);
    expect(() => readLabelSpans(metaWith(inside, [], 0, 11))).toThrow();
    expect(() => readLabelSpans(metaWith(emptyTileLabelsMeta(), [6], 0, 0))).toThrow();
  });

  test("a span that is not whole vertices is unreadable", () => {
    const meta = metaWith(emptyTileLabelsMeta(), [], 6, 0);
    const spans = meta.spans.map((s, i) => (i === meta.spans.length - 2 ? { ...s, byteCount: s.byteCount - 4 } : s));
    expect(() => readLabelSpans({ ...meta, spans })).toThrow();
  });
});

describe("isTileLabelsMeta", () => {
  const counts = { glyphRunCount: 0, poiIconRunCount: 0, routeShieldRunCount: 0 };

  test("the parser's labels are read, the run styles as many as the runs", () => {
    expect(isTileLabelsMeta(emptyTileLabelsMeta(), counts)).toBe(true);
    const labels = emptyTileLabelsMeta();
    const withRun = { ...labels, text: { ...labels.text, glyphRunStyles: [style] } };
    expect(isTileLabelsMeta(withRun, counts)).toBe(false);
    expect(isTileLabelsMeta(withRun, { ...counts, glyphRunCount: 1 })).toBe(true);
    expect(isTileLabelsMeta({ ...labels, road: { ...labels.road, labelStyle: style } }, counts)).toBe(true);
  });

  test("anything else is not", () => {
    expect(isTileLabelsMeta(undefined, counts)).toBe(false);
    expect(isTileLabelsMeta({ text: [], road: [] }, counts)).toBe(false);
    const labels = emptyTileLabelsMeta();
    expect(isTileLabelsMeta({ ...labels, surface: {} }, counts)).toBe(false);
    expect(isTileLabelsMeta({ ...labels, road: { ...labels.road, labelStyle: 3 } }, counts)).toBe(false);
  });
});
