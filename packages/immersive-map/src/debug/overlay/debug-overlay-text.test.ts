// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the text parts of the Swift `DebugOverlayRendererTests`: the
// tile labels, the coordinate lines, the diagnostics sections (from what
// the web frame measures) and their styling.

import { describe, expect, test } from "vitest";
import { DebugOverlayDiagnosticsTextStylePlanner, type DebugOverlayDiagnosticsTextStyleRun } from "./debug-overlay-diagnostics-text-style-planner.ts";
import { type DebugOverlayFrameDiagnostics, DebugOverlayText } from "./debug-overlay-text.ts";

function diagnostics(frameIndex: number, frameDeltaSeconds: number | undefined, extra: Partial<DebugOverlayFrameDiagnostics> = {}): DebugOverlayFrameDiagnostics {
  return {
    frameIndex,
    frameDeltaSeconds,
    cpuMilliseconds: 3.5,
    gpuMilliseconds: undefined,
    drawCount: 120,
    tiles: { visible: 16, ready: 25, requested: 0, rendered: 16 },
    pending: { terrainTiles: 2, layerMeshes: 0, sceneModelMeshes: 1 },
    ...extra,
  };
}

describe("DebugOverlayText", () => {
  test("the tile coordinate label uses x/y/z order", () => {
    expect(DebugOverlayText.formatTileCoordinateString({ x: 154, y: 79, z: 8 })).toBe("tile = 154/79/8");
    expect(DebugOverlayText.formatTileAddress({ x: 154, y: 79, z: 8 })).toBe("154/79/8");
  });

  test("the terrain tag names the terrain zoom the relief is read from", () => {
    expect(DebugOverlayText.formatTerrainTag({ x: 1, y: 1, z: 14 }, undefined)).toBe("flat");
    expect(DebugOverlayText.formatTerrainTag({ x: 1, y: 1, z: 14 }, { scale: 1 })).toBe("t14");
    // A source a quarter of its terrain tile a side reads the terrain two zooms up.
    expect(DebugOverlayText.formatTerrainTag({ x: 1, y: 1, z: 14 }, { scale: 0.25 })).toBe("t12");
  });

  test("the coordinate lines", () => {
    expect(DebugOverlayText.makeCoordinateTextLines(5.412, 55.7558, 37.6173)).toEqual({ zoom: "z: 5.41", latLon: "lat: 55.756 lon: 37.617" });
  });

  test("the camera lines alone without the frame's numbers", () => {
    expect(DebugOverlayText.makeOverlayDiagnosticsTextLines(["camera z:5.41 pitch:36.00 bearing:18.00"], undefined)).toEqual(["camera z:5.41 pitch:36.00 bearing:18.00"]);
  });

  test("the camera lines come before the frame's sections", () => {
    const lines = DebugOverlayText.makeOverlayDiagnosticsTextLines(["camera z:5.41 pitch:36.00 bearing:18.00"], diagnostics(42, 0.0167));
    expect(lines.slice(0, 2)).toEqual(["[Camera]", "camera z:5.41 pitch:36.00 bearing:18.00"]);
    expect(lines).toContain("[Frame]");
    expect(lines.some((line) => line.startsWith("frame:42"))).toBe(true);
  });

  test("an unknown frame delta shows as dashes", () => {
    for (const delta of [0, undefined]) {
      const lines = DebugOverlayText.makeOverlayDiagnosticsTextLines([], diagnostics(1, delta));
      expect(lines).toContain("frame:1");
      expect(lines).toContain("dt:--");
      expect(lines).toContain("fps:--");
    }
  });

  test("the GPU time appears once measured", () => {
    const lines = DebugOverlayText.makeOverlayDiagnosticsTextLines([], diagnostics(42, 0.0167, { gpuMilliseconds: 5.25 }));
    // One value a line, so a reader finds the one they watch.
    for (const line of ["frame:42", "dt:16.70ms", "fps:59.9", "gpu:5.25ms"]) expect(lines).toContain(line);
    expect(DebugOverlayText.makeOverlayDiagnosticsTextLines([], diagnostics(42, 0.0167)).some((line) => line.startsWith("gpu:"))).toBe(false);
  });

  test("the sections group the frame's numbers", () => {
    const lines = DebugOverlayText.makeOverlayDiagnosticsTextLines(
      ["camera z:3.93 pitch:0.00 bearing:15.00", "surface:globe transition:0.00 viewport:3298x1996"],
      diagnostics(909, 0.06744, { heapBytes: 128 * 1024 * 1024, labelCounts: { base: 181, roadGlyphs: 0, roadInstances: 0 } }),
    );
    expect(lines).toEqual([
      "[Camera]",
      "camera z:3.93 pitch:0.00 bearing:15.00",
      "surface:globe transition:0.00 viewport:3298x1996",
      "",
      "[Frame]",
      "frame:909",
      "dt:67.44ms",
      "fps:14.8",
      "cpu:3.50ms",
      "draws:120",
      "memory heap:128.0MB",
      "",
      "[Tiles]",
      "vis:16",
      "ready:25",
      "req:0",
      "draw:16",
      "",
      "[Pending]",
      "terrain:2",
      "layers:0",
      "models:1",
      "",
      "[Labels]",
      "base:181",
      "roadG:0",
      "roadI:0",
    ]);
  });
});

describe("DebugOverlayDiagnosticsTextStylePlanner", () => {
  test("marks the sections, the keys and the Skip section's body", () => {
    const text = ["[Frame]", "frame:73 dt:3.55ms fps:281.9", "", "[Skip]", "debugOverlayDisabled,noPinContent"].join("\n");
    const runs = DebugOverlayDiagnosticsTextStylePlanner.makeRuns(text);
    const rangeOf = (part: string) => ({ location: text.indexOf(part), length: part.length });
    const has = (run: DebugOverlayDiagnosticsTextStyleRun) => runs.some((candidate) => JSON.stringify(candidate) === JSON.stringify(run));

    expect(has({ ...rangeOf("[Frame]"), style: { kind: "section", title: "Frame" } })).toBe(true);
    expect(has({ ...rangeOf("frame:"), style: { kind: "key" } })).toBe(true);
    expect(has({ ...rangeOf("dt:"), style: { kind: "key" } })).toBe(true);
    expect(has({ ...rangeOf("[Skip]"), style: { kind: "section", title: "Skip" } })).toBe(true);
    expect(has({ ...rangeOf("debugOverlayDisabled,noPinContent"), style: { kind: "warningValue" } })).toBe(true);
    expect(has({ ...rangeOf("73"), style: { kind: "key" } })).toBe(false);
  });

  test("a Skip section reading none is no warning", () => {
    const runs = DebugOverlayDiagnosticsTextStylePlanner.makeRuns("[Skip]\nnone");
    expect(runs.some((run) => run.style.kind === "warningValue")).toBe(false);
  });
});
