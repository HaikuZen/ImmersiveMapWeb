// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { readStandingGeometry } from "./standing-geometry.ts";
import { arenaSlots, type ArenaSpan, type TileArenaMeta } from "./tile-gpu.ts";

const counts = { glyphRunCount: 0, poiIconRunCount: 0, routeShieldRunCount: 0 };

/** A metadata whose standing slots carry these spans, every other slot empty. */
function meta(standing: Partial<Record<"extrudedVertices" | "extrudedIndices" | "extrudedStyles" | "treeInstances", ArenaSpan>>): TileArenaMeta {
  const spans = arenaSlots(counts).map((slot) => (standing as Record<string, ArenaSpan | undefined>)[slot.kind] ?? { byteOffset: 0, byteCount: 0, elementCount: 0 });
  return { textRunCounts: counts, spans, buildingQuarterIndexStarts: [0, 6, 6, 12, 12], treeQuarterStarts: [] } as unknown as TileArenaMeta;
}

describe("readStandingGeometry", () => {
  test("reads the buildings and the trees of their slots", () => {
    const geometry = readStandingGeometry(
      meta({
        extrudedVertices: { byteOffset: 256, byteCount: 120, elementCount: 10 },
        extrudedIndices: { byteOffset: 512, byteCount: 24, elementCount: 12, indexWidth: 2 },
        extrudedStyles: { byteOffset: 768, byteCount: 32, elementCount: 2 },
        treeInstances: { byteOffset: 1024, byteCount: 48, elementCount: 3 },
      }),
    );
    expect(geometry.extruded).toEqual({
      vertexOffset: 256,
      vertexByteCount: 120,
      firstIndex: 256,
      indexCount: 12,
      indexFormat: "uint16",
      stylesOffset: 768,
      stylesByteCount: 32,
      quarterIndexStarts: [0, 6, 6, 12, 12],
    });
    expect(geometry.trees).toEqual({ byteOffset: 1024, count: 3, quarterStarts: [] });
  });

  test("a tile without buildings or trees has neither", () => {
    const geometry = readStandingGeometry(meta({}));
    expect(geometry.extruded).toBeUndefined();
    expect(geometry.trees).toBeUndefined();
  });

  test("spans that are not whole elements of their kind draw nothing", () => {
    const geometry = readStandingGeometry(
      meta({
        extrudedVertices: { byteOffset: 256, byteCount: 100, elementCount: 10 },
        extrudedIndices: { byteOffset: 512, byteCount: 24, elementCount: 12, indexWidth: 2 },
        extrudedStyles: { byteOffset: 768, byteCount: 32, elementCount: 2 },
        treeInstances: { byteOffset: 1024, byteCount: 40, elementCount: 3 },
      }),
    );
    expect(geometry.extruded).toBeUndefined();
    expect(geometry.trees).toBeUndefined();
  });
});
