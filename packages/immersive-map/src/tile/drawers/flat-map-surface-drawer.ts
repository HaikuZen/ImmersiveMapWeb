// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The flat map's ground and what lies on it, a port of the Swift
 * `FlatMapSurfaceDrawer`, on the plane and on the ground relief.
 *
 * Unique sources, not placements, are drawn: a tile placed in several slots
 * draws once at full extent, and the tile-priority stencil the placement
 * prepass filled gives it exactly the ground of its placements, in whatever
 * order the sources draw. The ground draws as class layers: the opaque fill
 * layers first, unblended, writing the rank-band depth and owning the
 * stencil, then the translucent fills, tested only. What lies on the ground
 * (the ribbons, the roads, the bridges) draws after the buildings and the
 * models, in the "roads" part: the road buckets are ordered by depth (every
 * layer of every structure has its band of ranks), opaque layers unblended,
 * the rest blended nearest first, then every deferred road's one-pixel edge
 * lines at half its alpha, then the bridge overlay.
 *
 * On the relief a flattened source rises by the terrain of the ring of the
 * finest slot it stands in (`PlaceTile.displacement`, its slopes shaded by
 * `PlaceTile.terrain`), so a source placed in its own slot and as a
 * stand-in rises by one terrain, drawn through the relief variant of every
 * class's pipeline with the source's relief bound at group 3. A source
 * whose terrain is not in, or a tile parsed in layers, draws on the plane.
 */

import { GlobeSurfaceDepthRank, RoadRankDepth, roadEdgeLineAlpha, TileSourceStencilPriority } from "./depth-rank.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Mat4 } from "../../math/matrix.ts";
import { mat4Invert } from "../../math/mat4-invert.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import { lineDashUnitsPerPixel } from "../../render/core/render-layer.ts";
import type { DrawParameters } from "../../render/core/draw-parameters.ts";
import { step as subdivisionStep } from "../ground-subdivision.ts";
import type { PlaceTile } from "../placement/place-tile.ts";
import type { FlatTileClass, FlatTilePipelines } from "../pipelines/tile-pipeline.ts";
import { type GpuGeometryLayer, type GpuTile, GroundStyleRunFlag, type GroundStyleRun, roadLayerKey, roadLayerPass, styleFadeProgress } from "../store/tile-gpu.ts";
import { type Tile, tileKey } from "../tile.ts";
import type { GroundReliefFrame } from "../relief/frame/ground-relief-frame.ts";
import type { GroundReliefGpu } from "../relief/frame/ground-relief-gpu.ts";
import type { GroundRelief } from "../relief/lifts/ground-relief.ts";

export interface FlatResidentTile {
  readonly tile: Tile;
  readonly gpu: GpuTile;
}

export interface FlatSurfaceFrame {
  /** The frame's camera and overview-fade uniforms (group 0). */
  frameBindGroup: GPUBindGroup;
  /** The per-draw parameters (group 1), read at the draw's instance index. */
  drawParameters: DrawParameters;
  cameraZoom: number;
  pixelsPerPoint: number;
  drawHeightPx: number;
  flatRenderState: FlatRenderState;
  /** The relief's GPU side: every class's layout carries its group. */
  reliefGpu: GroundReliefGpu;
  /** The frame's relief, `undefined` on a map without one. */
  reliefFrame?: GroundReliefFrame | undefined;
}

export interface Source {
  resident: FlatResidentTile;
  worldWrap: number;
  stencilReference: number;
  drawsLines: boolean;
  drawsGround: boolean;
  /** The terrain the source shades its slopes by and the one it rises by: the finest of its placements'. */
  terrain: Tile | undefined;
  displacement: Tile | undefined;
  /** The source's relief this frame, resolved by `resolveReliefs`. */
  relief?: GroundRelief | undefined;
  shading?: GroundRelief | undefined;
}

/** The byte size of the overview-fade uniform (tile-shading.wgsl `OverviewFade`). */
export const OVERVIEW_FADE_BYTES = 64;

/**
 * The view depth of the ground point under the centre of the screen: the depth
 * the point-locked widths are stated at, 0 when the centre ray misses the ground.
 */
export function screenCentreGroundDepth(cameraMatrix: Mat4, scratch: Mat4 = new Float64Array(16)): number {
  if (!mat4Invert(scratch, cameraMatrix)) return 0;
  const unproject = (z: number): [number, number, number] | undefined => {
    const x = scratch[8]! * z + scratch[12]!;
    const y = scratch[9]! * z + scratch[13]!;
    const zz = scratch[10]! * z + scratch[14]!;
    const w = scratch[11]! * z + scratch[15]!;
    if (Math.abs(w) <= Number.MIN_VALUE) return undefined;
    return [x / w, y / w, zz / w];
  };
  const near = unproject(0);
  const far = unproject(1);
  if (!near || !far) return 0;
  const descent = near[2] - far[2];
  if (Math.abs(descent) <= Number.MIN_VALUE) return 0;
  const t = near[2] / descent;
  if (!Number.isFinite(t) || t <= 0) return 0;
  const gx = near[0] + (far[0] - near[0]) * t;
  const gy = near[1] + (far[1] - near[1]) * t;
  const depth = cameraMatrix[3]! * gx + cameraMatrix[7]! * gy + cameraMatrix[15]!;
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/**
 * Writes the overview-fade uniform (the Swift `TileOverviewFadeUniform`) from
 * the CPU camera matrix, not the GPU-adjusted one. `pointWidthReferenceDepth`
 * is the view depth the point-locked road widths are stated at, the ground
 * under the centre of the screen: on a relief the terrain there
 * (`GroundReliefCameraLift.centreGroundDepth`), the plane when left out.
 */
export function writeOverviewFade(target: Float32Array, pixelsPerPoint: number, cameraZoom: number, widthPx: number, heightPx: number, cameraMatrix: Mat4, pointWidthReferenceDepth?: number): void {
  const referenceDepth = pointWidthReferenceDepth ?? screenCentreGroundDepth(cameraMatrix);
  // Columns 0 and 1: the ground axes; their x, y and w rows.
  const ax = [cameraMatrix[0]!, cameraMatrix[1]!, cameraMatrix[3]!] as const;
  const ay = [cameraMatrix[4]!, cameraMatrix[5]!, cameraMatrix[7]!] as const;
  let centrePx = 0;
  if (referenceDepth > 0) {
    const gradient = [ax[2], ay[2]];
    const len = Math.hypot(gradient[0]!, gradient[1]!);
    const across = len > 1e-9 ? [-gradient[1]! / len, gradient[0]! / len] : [1, 0];
    const stepX = ax[0] * across[0]! + ay[0] * across[1]!;
    const stepY = ax[1] * across[0]! + ay[1] * across[1]!;
    const pixels = Math.hypot(stepX * widthPx * 0.5, stepY * heightPx * 0.5) / referenceDepth;
    centrePx = Number.isFinite(pixels) ? pixels : 0;
  }
  target[0] = pixelsPerPoint;
  target[1] = cameraZoom;
  target[2] = widthPx;
  target[3] = heightPx;
  target[4] = referenceDepth;
  target[5] = centrePx;
  target[6] = 0;
  target[7] = 0;
  target[8] = ax[0];
  target[9] = ax[1];
  target[10] = ax[2];
  target[11] = 0;
  target[12] = ay[0];
  target[13] = ay[1];
  target[14] = ay[2];
  target[15] = 0;
}

/**
 * The index spans of a ground layer worth drawing: zero-fade runs drop out,
 * contiguous survivors merge. A layer without a run table draws nothing.
 * The raster tiles' bake draws its fills through the same spans.
 */
export function visibleRunSpans(layer: GpuGeometryLayer, cameraZoom: number, filter: (run: GroundStyleRun) => boolean): [number, number][] {
  if (layer.indexCount === 0) return [];
  if (layer.runs.length === 0) return [];
  const spans: [number, number][] = [];
  for (const run of layer.runs) {
    if (!filter(run) || styleFadeProgress(run.zoomFade, cameraZoom) <= 0) continue;
    const last = spans.at(-1);
    if (last && last[0] + last[1] === run.indexStart) last[1] += run.indexCount;
    else spans.push([run.indexStart, run.indexCount]);
  }
  return spans;
}

export class FlatMapSurfaceDrawer {
  constructor(private readonly pipelines: FlatTilePipelines) {}

  /** The unique sources of the placements, finest first (for the pipeline's sake alone). */
  sources(placements: readonly PlaceTile<FlatResidentTile>[]): Source[] {
    const byKey = new Map<string, Source>();
    for (const p of placements) {
      const key = `${tileKey(p.resident.tile)}@${p.placeIn.worldWrap}`;
      const drawsLines = p.rules.drawsLines;
      const drawsGround = p.rules.raster === undefined;
      const existing = byKey.get(key);
      if (existing) {
        existing.drawsLines ||= drawsLines;
        existing.drawsGround ||= drawsGround;
        // One terrain wherever the source draws: the finest of its placements'.
        if (p.terrain !== undefined && p.terrain.z > (existing.terrain?.z ?? -1)) existing.terrain = p.terrain;
        if (p.displacement !== undefined && p.displacement.z > (existing.displacement?.z ?? -1)) existing.displacement = p.displacement;
      } else {
        byKey.set(key, {
          resident: p.resident,
          worldWrap: p.placeIn.worldWrap,
          stencilReference: TileSourceStencilPriority.reference(p.resident.tile.z),
          drawsLines,
          drawsGround,
          terrain: p.terrain,
          displacement: p.displacement,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => b.stencilReference - a.stencilReference);
  }

  /**
   * Each flattened source's relief on the frame's: the terrain it rises by
   * and the one it shades by, `undefined` for a source on the plane.
   */
  static resolveReliefs(sources: readonly Source[], frame: GroundReliefFrame | undefined): void {
    for (const source of sources) {
      const tile = source.resident.tile;
      const flattened = source.resident.gpu.ground.isFlattened;
      source.relief = frame !== undefined && flattened && source.displacement !== undefined ? frame.relief(tile, source.displacement) : undefined;
      source.shading = source.relief !== undefined && source.terrain !== undefined ? frame?.relief(tile, source.terrain) : undefined;
    }
  }

  draw(pass: GPURenderPassEncoder, frame: FlatSurfaceFrame, sources: readonly Source[], part: "ground" | "roads"): void {
    pass.setBindGroup(0, frame.frameBindGroup);
    let boundDraws: GPUBindGroup | undefined;
    let boundStyles: GPUBindGroup | undefined;
    let boundVertexBuffer: GPUBuffer | undefined;
    let boundIndexBuffer: GPUBuffer | undefined;
    let boundIndexFormat: GPUIndexFormat | undefined;
    let boundStencil: number | undefined;
    let selected: string | undefined;
    const reliefFrame = frame.reliefFrame;
    const reliefGpu = frame.reliefGpu;
    // Every class's layout carries the relief's group: a frame on the plane
    // binds the empty one, a relief source its own over it.
    reliefGpu.bindEmpty(pass, 3);
    let boundRelief: Source | undefined;
    const select = (c: FlatTileClass, source: Source) => {
      const raised = reliefFrame !== undefined && source.relief !== undefined;
      const key = `${c}${raised ? "+" : ""}`;
      if (selected !== key) {
        selected = key;
        pass.setPipeline(this.pipelines.pipeline(c, raised));
      }
      if (raised && boundRelief !== source) {
        boundRelief = source;
        reliefGpu.bind(pass, 3, source.relief!, source.shading, source.resident.tile, reliefFrame, frame.flatRenderState.renderMapSize);
      }
    };

    const drawLayer = (source: Source, layer: GpuGeometryLayer, c: FlatTileClass, bandOffset: number, spans: [number, number][], alphaScale = 1) => {
      if (spans.length === 0 || !layer.styles) return;
      // The fills of a flattened ground take one depth: no rank step between their styles.
      const rankStep = c === "opaqueFills" && layer.isFlattened ? 0 : GlobeSurfaceDepthRank.layerDepthStep;
      select(c, source);
      const instance = this.writeDraw(frame, source, bandOffset, rankStep, alphaScale);
      const draws = frame.drawParameters.bindGroup(this.pipelines.drawLayout);
      if (draws !== boundDraws) pass.setBindGroup(1, (boundDraws = draws));
      if (layer.styles !== boundStyles) pass.setBindGroup(2, (boundStyles = layer.styles));
      // The tile's whole arena is bound once: a layer is reached by its first
      // vertex and first index, not by binding its own range, which saves a
      // pair of state calls per draw (each call crosses into the GPU process).
      const buffer = source.resident.gpu.buffer;
      if (buffer !== boundVertexBuffer) pass.setVertexBuffer(0, (boundVertexBuffer = buffer));
      if (buffer !== boundIndexBuffer || layer.indexFormat !== boundIndexFormat) {
        pass.setIndexBuffer(buffer, layer.indexFormat);
        boundIndexBuffer = buffer;
        boundIndexFormat = layer.indexFormat;
      }
      if (source.stencilReference !== boundStencil) pass.setStencilReference((boundStencil = source.stencilReference));
      const baseVertex = layer.vertexOffset / 16;
      const firstIndex = layer.indexOffset / (layer.indexFormat === "uint16" ? 2 : 4);
      for (const [start, count] of spans) pass.drawIndexed(count, 1, firstIndex + start, baseVertex, instance);
    };

    const zoom = frame.cameraZoom;
    // A flattened ground's fills overlap nowhere: every run draws in the opaque pass.
    const isOpaqueFill = (run: GroundStyleRun) =>
      (run.flags & GroundStyleRunFlag.linesClass) === 0 &&
      ((run.flags & GroundStyleRunFlag.flattened) !== 0 || ((run.flags & GroundStyleRunFlag.alphaOpaque) !== 0 && styleFadeProgress(run.zoomFade, zoom) >= 1));
    const isTranslucentFill = (run: GroundStyleRun) => (run.flags & GroundStyleRunFlag.linesClass) === 0 && !isOpaqueFill(run);
    const isLines = (run: GroundStyleRun) => (run.flags & GroundStyleRunFlag.linesClass) !== 0;

    if (part === "ground") {
      for (const s of sources) if (s.drawsGround) drawLayer(s, s.resident.gpu.ground, "opaqueFills", 0, visibleRunSpans(s.resident.gpu.ground, zoom, isOpaqueFill));
      for (const s of sources) if (s.drawsGround) drawLayer(s, s.resident.gpu.ground, "fills", 0, visibleRunSpans(s.resident.gpu.ground, zoom, isTranslucentFill));
      return;
    }

    const lined = sources.filter((s) => s.drawsLines);
    for (const s of lined) drawLayer(s, s.resident.gpu.ground, "lines", GlobeSurfaceDepthRank.classDepthBand, visibleRunSpans(s.resident.gpu.ground, zoom, isLines));

    type RoadDraw = { source: Source; layer: GpuGeometryLayer; band: number; pass: "opaque" | "blended" | "baked" };
    const roadDraws: RoadDraw[] = [];
    for (const entry of RoadRankDepth.layersNearestFirst) {
      for (const source of lined) {
        const layer = source.resident.gpu.roads.get(roadLayerKey(entry.structureKind, entry.role));
        if (!layer || layer.indexCount === 0) continue;
        let p: RoadDraw["pass"];
        if (subdivisionStep(source.resident.tile.z) !== undefined) {
          p = "baked";
        } else {
          const lp = roadLayerPass(layer.roadStyles, zoom);
          if (lp === "hidden") continue;
          p = lp;
        }
        roadDraws.push({ source, layer, band: entry.band, pass: p });
      }
    }
    const edgeStart = (layer: GpuGeometryLayer) => Math.min(Math.max(layer.edgeLineIndexStart ?? layer.indexCount, 0), layer.indexCount);
    for (const opaque of [true, false]) {
      for (const d of roadDraws) {
        if ((d.pass === "opaque") !== opaque) continue;
        const offset = RoadRankDepth.depthOffset(d.band);
        if (d.pass === "baked") drawLayer(d.source, d.layer, "lines", offset, [[0, d.layer.indexCount]]);
        else {
          const bodies = edgeStart(d.layer);
          drawLayer(d.source, d.layer, d.pass === "opaque" ? "roadOpaque" : "roadBlended", offset, bodies > 0 ? [[0, bodies]] : []);
        }
      }
    }
    for (const d of roadDraws) {
      if (d.pass === "baked") continue;
      const start = edgeStart(d.layer);
      if (start < d.layer.indexCount) drawLayer(d.source, d.layer, "roadEdgeLines", RoadRankDepth.depthOffset(d.band), [[start, d.layer.indexCount - start]], roadEdgeLineAlpha);
    }
    for (const s of lined) {
      const layer = s.resident.gpu.bridgeOverlay;
      drawLayer(s, layer, "lines", RoadRankDepth.depthOffset(RoadRankDepth.bridgeOverlayBand), layer.indexCount > 0 ? [[0, layer.indexCount]] : []);
    }
  }

  /** The draw's uniform slot: the tile's model matrix, its depth band, its alpha scale and its dash scale. */
  private writeDraw(frame: FlatSurfaceFrame, source: Source, bandOffset: number, rankStep: number, alphaScale: number): number {
    const tile = source.resident.tile;
    const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, source.worldWrap, frame.flatRenderState.pan, frame.flatRenderState.renderMapSize);
    const scale = size / 4096;
    const record = frame.drawParameters.allocate();
    const f = frame.drawParameters.f32;
    const i = record.index;
    f[i] = scale;
    f[i + 5] = scale;
    f[i + 10] = 1;
    f[i + 12] = ox;
    f[i + 13] = oy;
    f[i + 15] = 1;
    f[i + 16] = bandOffset;
    f[i + 17] = rankStep;
    f[i + 18] = alphaScale;
    f[i + 19] = frame.pixelsPerPoint * lineDashUnitsPerPixel(size, frame.drawHeightPx);
    return record.instance;
  }
}
