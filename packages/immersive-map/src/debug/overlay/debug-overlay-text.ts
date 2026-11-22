// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { DebugFramePendingCounts, DebugFrameTileCounts, DebugLabelCounts } from "../../render/debug/debug-frame-report.ts";
import type { Tile } from "../../tile/tile.ts";

/** The HUD's two coordinate lines: the zoom, and the latitude and longitude the camera looks at. */
export interface DebugOverlayCoordinateLines {
  readonly zoom: string;
  readonly latLon: string;
}

/**
 * The frame's numbers for the diagnostics text: what the web frame measures,
 * in place of the Swift `FrameDiagnostics` with its stage timings and
 * counters.
 */
export interface DebugOverlayFrameDiagnostics {
  readonly frameIndex: number;
  /** Seconds since the previous frame, `undefined` or 0 when unknown. */
  readonly frameDeltaSeconds: number | undefined;
  readonly cpuMilliseconds: number;
  /** `undefined` without `timestamp-query`. */
  readonly gpuMilliseconds: number | undefined;
  readonly drawCount: number;
  readonly tiles: DebugFrameTileCounts;
  readonly pending: DebugFramePendingCounts;
  readonly labelCounts?: DebugLabelCounts | undefined;
  /** The JavaScript heap in use, where the browser reports it (`performance.memory.usedJSHeapSize`). */
  readonly heapBytes?: number | undefined;
}

/** The watermark's terrain part for a tile without a relief. */
export const flatTerrainTag = "flat";

/**
 * The debug overlay's text (the Swift `DebugOverlayRenderer`'s static
 * formatters): the coordinate lines, the tile labels and the diagnostics.
 */
export const DebugOverlayText = {
  makeCoordinateTextLines(zoom: number, latitude: number, longitude: number): DebugOverlayCoordinateLines {
    return { zoom: `z: ${zoom.toFixed(2)}`, latLon: `lat: ${latitude.toFixed(3)} lon: ${longitude.toFixed(3)}` };
  },

  formatTileCoordinateString(tile: Tile): string {
    return `tile = ${tile.x}/${tile.y}/${tile.z}`;
  },

  /** The watermark's address part: the tile's own, without the prefix. */
  formatTileAddress(tile: Tile): string {
    return `${tile.x}/${tile.y}/${tile.z}`;
  },

  /**
   * The watermark's terrain part, when the tile is on the ground relief:
   * `t11` for a source tile whose relief is read out of the zoom 11 terrain,
   * the ring's or a coarser stand-in's (`GroundReliefFrame.relief`), `flat`
   * for a tile without one. `tile` is the source drawn, the relief's own
   * tile, and `relief.scale` the share of the terrain tile it covers.
   */
  formatTerrainTag(tile: Tile, relief: { readonly scale: number } | undefined): string {
    if (relief === undefined) return flatTerrainTag;
    const depth = Math.round(Math.log2(1 / Math.max(relief.scale, 1e-6)));
    return `t${tile.z - depth}`;
  },

  /**
   * The diagnostics lines: the camera's lines alone without the frame's
   * numbers, else the camera's under a `[Camera]` title and the frame's in
   * sections after them. One value a line in every section, so a reader
   * finds the one they watch.
   */
  makeOverlayDiagnosticsTextLines(cameraDebugLines: readonly string[], diagnostics: DebugOverlayFrameDiagnostics | undefined): string[] {
    if (diagnostics === undefined) return [...cameraDebugLines];
    const lines: string[] = [];
    appendSection("Camera", cameraDebugLines, lines);

    const delta = diagnostics.frameDeltaSeconds;
    const hasKnownFrameDelta = delta !== undefined && Number.isFinite(delta) && delta > 0;
    const frameLines = [
      `frame:${diagnostics.frameIndex}`,
      `dt:${hasKnownFrameDelta ? `${(delta * 1000).toFixed(2)}ms` : "--"}`,
      `fps:${hasKnownFrameDelta ? (1 / delta).toFixed(1) : "--"}`,
      `cpu:${diagnostics.cpuMilliseconds.toFixed(2)}ms`,
    ];
    const gpu = diagnostics.gpuMilliseconds;
    if (gpu !== undefined && gpu > 0) frameLines.push(`gpu:${gpu.toFixed(2)}ms`);
    frameLines.push(`draws:${diagnostics.drawCount}`);
    if (diagnostics.heapBytes !== undefined) frameLines.push(`memory heap:${(diagnostics.heapBytes / 1_048_576).toFixed(1)}MB`);
    appendSection("Frame", frameLines, lines);

    const tiles = diagnostics.tiles;
    appendSection("Tiles", [`vis:${tiles.visible}`, `ready:${tiles.ready}`, `req:${tiles.requested}`, `draw:${tiles.rendered}`], lines);

    const pending = diagnostics.pending;
    appendSection("Pending", [`terrain:${pending.terrainTiles}`, `layers:${pending.layerMeshes}`, `models:${pending.sceneModelMeshes}`], lines);

    const labels = diagnostics.labelCounts;
    if (labels !== undefined) appendSection("Labels", [`base:${labels.base}`, `roadG:${labels.roadGlyphs}`, `roadI:${labels.roadInstances}`], lines);
    return lines;
  },
} as const;

function appendSection(title: string, body: readonly string[], lines: string[]): void {
  if (body.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(`[${title}]`, ...body);
}
