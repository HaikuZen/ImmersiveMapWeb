// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A tile resident in the map's working set: its GPU state and what the
 * planners read of it (the Swift `MetalTile`). Made on the main thread from
 * a prepared tile the workers hand over (`PreparedTilePayload`).
 */

import { makeTileTextLabels } from "../../labels/base/tile-text-labels.ts";
import type { LabelSourceTile } from "../../labels/base/base-label-cache.ts";
import type { FlatResidentTile } from "../drawers/flat-map-surface-drawer.ts";
import type { Tile } from "../tile.ts";
import type { WorkingSetTile } from "./working-set.ts";
import { isTileLabelsMeta } from "./prepared-labels.ts";
import { createGpuTile, type GpuTile, type TileArenaMeta } from "./tile-gpu.ts";
import type { BuildingAnchorTile } from "../relief/lifts/building-relief-lifts.ts";

export interface MapTile extends WorkingSetTile, FlatResidentTile, LabelSourceTile, BuildingAnchorTile {
  readonly tile: Tile;
  readonly gpu: GpuTile;
}

/** The parser's metadata beside the arena: the arena's own, and what the planners read. */
export interface PreparedTileMeta extends TileArenaMeta {
  readonly groundIsFlattened: boolean;
}

const isArray = Array.isArray;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The metadata of a prepared tile, `undefined` when it is not the parser's
 * arena metadata (an entry of another format, a damaged one): the tile is
 * then reported unreadable, and the loader drops the disk entry and parses
 * the tile again. The spans themselves are checked against the arena at the
 * upload (`createGpuTile`).
 */
export function readPreparedTileMeta(meta: unknown): PreparedTileMeta | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const m = meta as Partial<Record<keyof PreparedTileMeta, unknown>>;
  if (m.kind !== "arena" || !isNumber(m.formatVersion)) return undefined;
  if (!isArray(m.spans) || !m.spans.every((s) => typeof s === "object" && s !== null && isNumber(s.byteOffset) && isNumber(s.byteCount) && isNumber(s.elementCount))) return undefined;
  const counts = m.textRunCounts as Partial<Record<string, unknown>> | undefined;
  if (typeof counts !== "object" || counts === null || !isNumber(counts.glyphRunCount) || !isNumber(counts.poiIconRunCount) || !isNumber(counts.routeShieldRunCount)) return undefined;
  if (!isArray(m.groundStyleRuns) || !isArray(m.roadEdgeLineIndexStarts) || !isArray(m.buildingRanges) || !isArray(m.buildingAnchors)) return undefined;
  if (!isArray(m.buildingQuarterIndexStarts) || !isArray(m.treeQuarterStarts)) return undefined;
  if (!isTileLabelsMeta(m.labels, { glyphRunCount: counts.glyphRunCount, poiIconRunCount: counts.poiIconRunCount, routeShieldRunCount: counts.routeShieldRunCount })) return undefined;
  return { ...(meta as TileArenaMeta), groundIsFlattened: m.groundIsFlattened === true };
}

/** Uploads a prepared tile, `undefined` when its metadata or its arena cannot be read. */
export function makeMapTile(device: GPUDevice, stylesLayout: GPUBindGroupLayout, tile: Tile, arena: ArrayBuffer, rawMeta: unknown): MapTile | undefined {
  const meta = readPreparedTileMeta(rawMeta);
  if (meta === undefined) return undefined;
  let gpu: GpuTile;
  try {
    gpu = createGpuTile(device, stylesLayout, arena, meta);
  } catch {
    return undefined;
  }
  return {
    tile,
    gpu,
    // The screen labels' columns and their rank order, made once with the tile.
    textLabels: makeTileTextLabels(meta.labels.text),
    groundIsFlattened: meta.groundIsFlattened,
    // Each building's anchor by its ordinal, x and y in the tile's render
    // units: what the relief lifts the building by.
    buildingAnchors: Float32Array.from(meta.buildingAnchors.flat()),
    keepsBuildingsByQuarters: meta.buildingQuarterIndexStarts.length > 0,
  };
}
