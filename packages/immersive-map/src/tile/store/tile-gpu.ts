// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A prepared tile on the GPU: its arena (every GPU-bound array of the tile in
 * one blob, laid out by the canonical slot sequence with 256-byte-aligned
 * spans) uploaded as one buffer, and the views the drawers bind. A port of the
 * Swift `TileArenaSchema`, `TileBuffers`, `GroundStyleRun` and
 * `RoadLayerStyles`, and of the reading half of `MetalTileFactory`.
 *
 * The arena is the contract with the Wasm parser (crates/tile-parse), which
 * writes it, and with the disk cache, which keeps it as it is.
 */

import { type RoadPassRole, type RoadStructureKind, roadPassRoleDrawOrder, roadStructureDrawOrder } from "../drawers/depth-rank.ts";
import { labelVertexLayout, type TileLabelsMeta } from "./prepared-labels.ts";

export type GeometryLayerId = { kind: "ground" } | { kind: "road"; structure: RoadStructureKind; role: RoadPassRole } | { kind: "bridgeOverlay" };

export type ArenaSlot =
  | { kind: "geometryVertices" | "geometryIndices" | "geometryStyles" | "geometryStyleZoomFades" | "geometryLineStyles"; layer: GeometryLayerId }
  | { kind: "extrudedVertices" | "extrudedIndices" | "extrudedStyles" | "treeInstances" | "roadLabelGlyphVertices" | "surfaceLabelVertices" }
  | { kind: "glyphRunVertices" | "poiIconRunVertices" | "routeShieldRunVertices"; run: number };

export interface ArenaTextRunCounts {
  glyphRunCount: number;
  poiIconRunCount: number;
  routeShieldRunCount: number;
}

/** The geometry layers in the arena's order: the ground, the road buckets by structure and role, the bridge overlay. */
export function geometryLayerIds(): GeometryLayerId[] {
  const ids: GeometryLayerId[] = [{ kind: "ground" }];
  for (const structure of roadStructureDrawOrder) for (const role of roadPassRoleDrawOrder) ids.push({ kind: "road", structure, role });
  ids.push({ kind: "bridgeOverlay" });
  return ids;
}

/** The canonical slot sequence (the Swift `TileArenaSchema.slots`). */
export function arenaSlots(text: ArenaTextRunCounts): ArenaSlot[] {
  const slots: ArenaSlot[] = [];
  for (const layer of geometryLayerIds()) {
    for (const kind of ["geometryVertices", "geometryIndices", "geometryStyles", "geometryStyleZoomFades", "geometryLineStyles"] as const) slots.push({ kind, layer });
  }
  slots.push({ kind: "extrudedVertices" }, { kind: "extrudedIndices" }, { kind: "extrudedStyles" }, { kind: "treeInstances" });
  for (let run = 0; run < text.glyphRunCount; run++) slots.push({ kind: "glyphRunVertices", run });
  for (let run = 0; run < text.poiIconRunCount; run++) slots.push({ kind: "poiIconRunVertices", run });
  for (let run = 0; run < text.routeShieldRunCount; run++) slots.push({ kind: "routeShieldRunVertices", run });
  slots.push({ kind: "roadLabelGlyphVertices" }, { kind: "surfaceLabelVertices" });
  return slots;
}

/** Element strides of the non-index slots. */
export const ArenaStride = {
  tileVertex: 16,
  extrudedVertex: 12,
  polygonStyle: 16,
  zoomFade: 8,
  lineStyle: 68,
  treeInstance: 16,
  labelVertex: labelVertexLayout.stride,
} as const;

export const ARENA_SPAN_ALIGNMENT = 256;

/** One span of the arena, in slot order. `indexWidth` is set for index spans only. */
export interface ArenaSpan {
  byteOffset: number;
  byteCount: number;
  elementCount: number;
  indexWidth?: 2 | 4;
}

/** One run of the ground indices: one style and one class, in paint order (the Swift `GroundStyleRun`). */
export interface GroundStyleRun {
  indexStart: number;
  indexCount: number;
  /** The style's zoom fade: x the zoom of zero alpha, y of full alpha. */
  zoomFade: [number, number];
  flags: number;
}

export const GroundStyleRunFlag = {
  alphaOpaque: 1,
  linesClass: 2,
  flattened: 4,
  sphereVeiled: 8,
} as const;

/** The tile's CPU metadata, as the parser writes it beside the arena. */
export interface TileArenaMeta {
  kind: "arena";
  /** The prepared format version the arena was written under. */
  formatVersion: number;
  spans: ArenaSpan[];
  textRunCounts: ArenaTextRunCounts;
  groundStyleRuns: GroundStyleRun[];
  /** Where the edge lines start in each road layer's indices, in the arena's layer order. */
  roadEdgeLineIndexStarts: number[];
  /** Each building's place in the extruded indices: feature id (as a decimal string, a u64), start, count. */
  buildingRanges: [string, number, number][];
  buildingAnchors: [number, number][];
  buildingQuarterIndexStarts: number[];
  treeQuarterStarts: number[];
  /** The labels' records and run styles; their vertices are the label slots. */
  labels: TileLabelsMeta;
}

// MARK: Road layer styles

export interface RoadStyleInfo {
  isAlphaOpaque: boolean;
  zoomFade: [number, number];
  rampStartAlpha: number;
  rampStartZoom: number;
  rampEndZoom: number;
  isDashed: boolean;
}

export type RoadLayerPass = "hidden" | "opaque" | "blended";

/** The fade's progress at the camera zoom, exactly as the shader computes it (the Swift `TileStyleFadeMath`). */
export function styleFadeProgress(zoomFade: readonly [number, number], cameraZoom: number): number {
  const span = zoomFade[1] - zoomFade[0];
  if (span === 0) return cameraZoom >= zoomFade[1] ? 1 : 0;
  return Math.min(1, Math.max(0, (cameraZoom - zoomFade[0]) / span));
}

/** A road layer's pass this frame: opaque writes its rank unblended, anything else blends. */
export function roadLayerPass(styles: readonly RoadStyleInfo[], cameraZoom: number): RoadLayerPass {
  if (styles.length === 0) return "blended";
  if (styles.every((s) => styleFadeProgress(s.zoomFade, cameraZoom) <= 0)) return "hidden";
  const opaque = styles.every((s) => {
    const rampOne = s.rampStartAlpha >= 1 || s.rampEndZoom <= s.rampStartZoom || cameraZoom >= s.rampEndZoom;
    return s.isAlphaOpaque && !s.isDashed && rampOne && styleFadeProgress(s.zoomFade, cameraZoom) >= 1;
  });
  return opaque ? "opaque" : "blended";
}

// MARK: GPU tile

export interface GpuGeometryLayer {
  vertexOffset: number;
  vertexCount: number;
  indexOffset: number;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  /** The three style tables bound as storage, `undefined` for an empty layer. */
  styles: GPUBindGroup | undefined;
  runs: GroundStyleRun[];
  isFlattened: boolean;
  roadStyles: RoadStyleInfo[];
  /** The road buckets only: the index element the edge lines start at. */
  edgeLineIndexStart: number | undefined;
}

/** One label slot of the arena: where its vertices start in the tile's buffer and how many there are. */
export interface GpuLabelVertexSpan {
  readonly vertexOffset: number;
  readonly vertexCount: number;
}

/**
 * The label slots of a tile (the Swift `TileBuffers.TextLabelSet`,
 * `RoadLabels` and `SurfaceLabels` views): each run in the order of its
 * style in `TileArenaMeta.labels`.
 */
export interface GpuTileLabels {
  readonly glyphRuns: readonly GpuLabelVertexSpan[];
  readonly poiIconRuns: readonly GpuLabelVertexSpan[];
  readonly routeShieldRuns: readonly GpuLabelVertexSpan[];
  readonly roadGlyphs: GpuLabelVertexSpan;
  readonly surfaceGlyphs: GpuLabelVertexSpan;
}

export interface GpuTile {
  readonly buffer: GPUBuffer;
  readonly byteLength: number;
  readonly ground: GpuGeometryLayer;
  /** By `${structure}/${role}`. */
  readonly roads: ReadonlyMap<string, GpuGeometryLayer>;
  readonly bridgeOverlay: GpuGeometryLayer;
  readonly labels: GpuTileLabels;
  readonly meta: TileArenaMeta;
}

export const roadLayerKey = (structure: RoadStructureKind, role: RoadPassRole) => `${structure}/${role}`;

/** Reads a road layer's style tables out of the arena before upload. */
function readRoadStyles(arena: ArrayBuffer, styles: ArenaSpan, fades: ArenaSpan, lines: ArenaSpan): RoadStyleInfo[] {
  const count = styles.elementCount;
  if (count === 0 || fades.elementCount !== count || lines.elementCount !== count) return [];
  const view = new DataView(arena);
  const out: RoadStyleInfo[] = [];
  for (let i = 0; i < count; i++) {
    const alpha = view.getFloat32(styles.byteOffset + i * ArenaStride.polygonStyle + 12, true);
    const fadeBase = fades.byteOffset + i * ArenaStride.zoomFade;
    const lineBase = lines.byteOffset + i * ArenaStride.lineStyle;
    out.push({
      isAlphaOpaque: alpha >= 1,
      zoomFade: [view.getFloat32(fadeBase, true), view.getFloat32(fadeBase + 4, true)],
      // LineStyle: dashLengthPoints at 4, rampStartZoom at 36, rampEndZoom at 40, rampStartAlpha at 44.
      isDashed: view.getFloat32(lineBase + 4, true) > 0,
      rampStartZoom: view.getFloat32(lineBase + 36, true),
      rampEndZoom: view.getFloat32(lineBase + 40, true),
      rampStartAlpha: view.getFloat32(lineBase + 44, true),
    });
  }
  return out;
}

/**
 * The label slots' views, checked against what the metadata says of them:
 * whole vertices in every slot, one run per run style, every surface
 * record inside the surface glyphs. The metadata of a cached tile is
 * untrusted input like its span table (the Swift `MetalTileFactory`).
 */
export function readLabelSpans(meta: TileArenaMeta): GpuTileLabels {
  const slots = arenaSlots(meta.textRunCounts);
  const view = (index: number): GpuLabelVertexSpan => {
    const span = meta.spans[index]!;
    if (span.byteCount !== span.elementCount * ArenaStride.labelVertex) throw new Error("label span is not whole vertices");
    return { vertexOffset: span.byteOffset, vertexCount: span.elementCount };
  };
  const glyphRuns: GpuLabelVertexSpan[] = [];
  const poiIconRuns: GpuLabelVertexSpan[] = [];
  const routeShieldRuns: GpuLabelVertexSpan[] = [];
  let roadGlyphs: GpuLabelVertexSpan | undefined;
  let surfaceGlyphs: GpuLabelVertexSpan | undefined;
  slots.forEach((slot, index) => {
    if (slot.kind === "glyphRunVertices") glyphRuns.push(view(index));
    else if (slot.kind === "poiIconRunVertices") poiIconRuns.push(view(index));
    else if (slot.kind === "routeShieldRunVertices") routeShieldRuns.push(view(index));
    else if (slot.kind === "roadLabelGlyphVertices") roadGlyphs = view(index);
    else if (slot.kind === "surfaceLabelVertices") surfaceGlyphs = view(index);
  });
  const text = meta.labels.text;
  if (text.glyphRunStyles.length !== glyphRuns.length || text.poiIconRunStyles.length !== poiIconRuns.length || text.routeShieldRunStyles.length !== routeShieldRuns.length) {
    throw new Error("label run styles do not match the arena's runs");
  }
  if (roadGlyphs === undefined || surfaceGlyphs === undefined) throw new Error("arena has no label slots");
  const surfaceCount = surfaceGlyphs.vertexCount;
  for (const record of meta.labels.surface) {
    if (record.vertexStart < 0 || record.vertexCount < 0 || record.vertexStart > surfaceCount - record.vertexCount) throw new Error("surface label outside its glyphs");
  }
  return { glyphRuns, poiIconRuns, routeShieldRuns, roadGlyphs, surfaceGlyphs };
}

/**
 * Uploads a prepared tile: one buffer created mapped and filled in place
 * (transferred, then `mappedAtCreation`), the layers' views and style bind groups.
 * Throws when the span table does not match the slot sequence: the caller
 * reports the image unreadable.
 */
export function createGpuTile(device: GPUDevice, stylesLayout: GPUBindGroupLayout, arena: ArrayBuffer, meta: TileArenaMeta): GpuTile {
  const slots = arenaSlots(meta.textRunCounts);
  if (slots.length !== meta.spans.length) throw new Error(`arena has ${meta.spans.length} spans, the schema ${slots.length}`);
  for (const span of meta.spans) {
    if (span.byteOffset % ARENA_SPAN_ALIGNMENT !== 0 || span.byteOffset + span.byteCount > arena.byteLength) throw new Error("arena span out of bounds");
  }
  const labels = readLabelSpans(meta);
  const size = Math.max(16, Math.ceil(arena.byteLength / 4) * 4);
  const buffer = device.createBuffer({
    label: "tile arena",
    size,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange(), 0, arena.byteLength).set(new Uint8Array(arena));
  buffer.unmap();

  const layerIds = geometryLayerIds();
  const layers: GpuGeometryLayer[] = [];
  let roadIndex = 0;
  for (let l = 0; l < layerIds.length; l++) {
    const [vertices, indices, styles, fades, lines] = meta.spans.slice(l * 5, l * 5 + 5) as [ArenaSpan, ArenaSpan, ArenaSpan, ArenaSpan, ArenaSpan];
    const id = layerIds[l]!;
    const empty = indices.elementCount === 0 || styles.byteCount === 0;
    const bindGroup = empty
      ? undefined
      : device.createBindGroup({
          layout: stylesLayout,
          entries: [
            { binding: 0, resource: { buffer, offset: styles.byteOffset, size: styles.byteCount } },
            { binding: 1, resource: { buffer, offset: fades.byteOffset, size: Math.max(8, fades.byteCount) } },
            { binding: 2, resource: { buffer, offset: lines.byteOffset, size: Math.max(68, lines.byteCount) } },
          ],
        });
    const isRoad = id.kind === "road";
    layers.push({
      vertexOffset: vertices.byteOffset,
      vertexCount: vertices.elementCount,
      indexOffset: indices.byteOffset,
      indexCount: indices.elementCount,
      indexFormat: indices.indexWidth === 2 ? "uint16" : "uint32",
      styles: bindGroup,
      runs: id.kind === "ground" ? meta.groundStyleRuns : [],
      isFlattened: id.kind === "ground" && meta.groundStyleRuns.some((r) => (r.flags & GroundStyleRunFlag.flattened) !== 0),
      roadStyles: isRoad ? readRoadStyles(arena, styles, fades, lines) : [],
      edgeLineIndexStart: isRoad ? meta.roadEdgeLineIndexStarts[roadIndex] : undefined,
    });
    if (isRoad) roadIndex++;
  }
  const roads = new Map<string, GpuGeometryLayer>();
  layerIds.forEach((id, i) => {
    if (id.kind === "road") roads.set(roadLayerKey(id.structure, id.role), layers[i]!);
  });
  return { buffer, byteLength: size, ground: layers[0]!, roads, bridgeOverlay: layers[layers.length - 1]!, labels, meta };
}
