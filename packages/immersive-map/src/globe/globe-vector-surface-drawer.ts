// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The globe counterpart of `FlatMapSurfaceDrawer`, a port of the Swift
 * `GlobeVectorSurfaceDrawer`: every placement's ground layer (below tile
 * zoom 8 the whole drawable content of a tile lives there) through the
 * sphere tile pipelines, on the resting sphere and through the unroll alike.
 *
 * The sphere draws unique sources, not placements: a coarse tile standing in
 * for several missing slots is drawn once at its full extent, and what keeps
 * it out of a covered slot is the tile-priority stencil the placement
 * prepass filled with the planner's decision. Finest first for the
 * pipeline's sake alone.
 *
 * The ground draws as class layers. The opaque fill layers (a style whose
 * palette alpha is 1 and whose zoom fade is 1 this frame) draw first,
 * unblended, writing their rank depth in a narrow band at the far plane, so
 * a pixel is shaded by its topmost opaque layer. The translucent fill layers
 * follow in buffer order (bottom to top), tested without writing. The line
 * ribbons draw last, in their own depth band above every fill. With a veiled
 * stroke on screen (`GroundStyleRunFlag.sphereVeiled`) they draw in two
 * phases: the cores first, one draw per run from the highest rank down,
 * writing the rank under a strict test, so a pixel several strokes cover
 * blends once, by the highest, then the feathers, blended over them.
 */

import { lineDashUnitsPerPixel } from "../render/core/render-layer.ts";
import type { DrawParameters } from "../render/core/draw-parameters.ts";
import { TileSourceStencilPriority } from "../tile/drawers/depth-rank.ts";
import { type FlatResidentTile, visibleRunSpans } from "../tile/drawers/flat-map-surface-drawer.ts";
import type { PlaceTile } from "../tile/placement/place-tile.ts";
import type { SphereTileClass, SphereTilePipelines } from "../tile/pipelines/tile-sphere-pipeline.ts";
import { type GpuGeometryLayer, GroundStyleRunFlag, type GroundStyleRun, styleFadeProgress } from "../tile/store/tile-gpu.ts";
import { tileKey } from "../tile/tile.ts";
import { GlobeLineDashScale, GlobeSurfaceTile } from "./globe-frame-constants.ts";

export interface GlobeSurfaceFrame {
  /** The frame's uniforms (group 0), the globe's among them. */
  readonly frameBindGroup: GPUBindGroup;
  /** The per-draw parameters (group 1), read at the draw's instance index. */
  readonly drawParameters: DrawParameters;
  readonly cameraZoom: number;
  readonly pixelsPerPoint: number;
  readonly drawHeightPx: number;
  /** The flat map's width in render units: a source tile's world size on the equator is this over 2^z. */
  readonly renderMapSize: number;
  /** The unroll toward the plane is on (`GlobeSphereVertexPath`). */
  readonly morph: boolean;
}

/** One unique source of the frame's placements. */
export interface GlobeSurfaceSource {
  readonly resident: FlatResidentTile;
  readonly stencilReference: number;
  /** Some placement of it draws its line ribbons (`TileDrawRules.drawsLines`). */
  drawsLines: boolean;
  /** Some placement of it draws its fills as geometry, not from a raster texture. */
  drawsGround: boolean;
}

const isLines = (run: GroundStyleRun) => (run.flags & GroundStyleRunFlag.linesClass) !== 0;

export class GlobeVectorSurfaceDrawer {
  constructor(private readonly pipelines: SphereTilePipelines) {}

  /** The unique sources of the placements, finest first. */
  sources(placements: readonly PlaceTile<FlatResidentTile>[]): GlobeSurfaceSource[] {
    const byKey = new Map<string, GlobeSurfaceSource>();
    for (const p of placements) {
      const key = tileKey(p.resident.tile);
      const drawsLines = p.rules.drawsLines;
      const drawsGround = p.rules.raster === undefined;
      const existing = byKey.get(key);
      if (existing) {
        existing.drawsLines ||= drawsLines;
        existing.drawsGround ||= drawsGround;
      } else {
        byKey.set(key, { resident: p.resident, stencilReference: TileSourceStencilPriority.reference(p.resident.tile.z), drawsLines, drawsGround });
      }
    }
    return [...byKey.values()].sort((a, b) => b.resident.tile.z - a.resident.tile.z);
  }

  draw(pass: GPURenderPassEncoder, frame: GlobeSurfaceFrame, sources: readonly GlobeSurfaceSource[]): void {
    if (sources.length === 0) return;
    pass.setBindGroup(0, frame.frameBindGroup);
    const zoom = frame.cameraZoom;
    // One draw record per source serves every pass: its place on the
    // sphere and its dash scale do not change between them.
    const records = new Map<GlobeSurfaceSource, number>();
    const recordOf = (source: GlobeSurfaceSource): number => {
      let instance = records.get(source);
      if (instance === undefined) {
        instance = this.writeDraw(frame, source);
        records.set(source, instance);
      }
      return instance;
    };
    let boundDraws: GPUBindGroup | undefined;
    let boundSource: GlobeSurfaceSource | undefined;
    const drawSpans = (source: GlobeSurfaceSource, spans: readonly (readonly [number, number])[]) => {
      const layer = source.resident.gpu.ground;
      if (spans.length === 0 || !layer.styles) return;
      const instance = recordOf(source);
      const draws = frame.drawParameters.bindGroup(this.pipelines.drawLayout);
      if (draws !== boundDraws) pass.setBindGroup(1, (boundDraws = draws));
      if (boundSource !== source) {
        boundSource = source;
        this.bindSource(pass, source, layer);
      }
      for (const [start, count] of spans) pass.drawIndexed(count, 1, start, 0, instance);
    };
    // A pipeline change keeps the bound groups and buffers: a source bound
    // last in one class is not bound again first in the next.
    const select = (tileClass: SphereTileClass) => pass.setPipeline(this.pipelines.pipeline(tileClass, frame.morph));

    const isOpaqueFill = (run: GroundStyleRun) => !isLines(run) && (run.flags & GroundStyleRunFlag.alphaOpaque) !== 0 && styleFadeProgress(run.zoomFade, zoom) >= 1;
    const isTranslucentFill = (run: GroundStyleRun) => !isLines(run) && !isOpaqueFill(run);
    const groundSources = sources.filter((s) => s.drawsGround);
    const linedSources = sources.filter((s) => s.drawsLines);

    select("opaqueFills");
    for (const s of groundSources) drawSpans(s, visibleRunSpans(s.resident.gpu.ground, zoom, isOpaqueFill));
    select("fills");
    for (const s of groundSources) drawSpans(s, visibleRunSpans(s.resident.gpu.ground, zoom, isTranslucentFill));

    // The second ribbon draw is paid only where a veiled stroke is on
    // screen: the phases are per frame, since the cores' depth must be in
    // before any feather is tested.
    const isVisibleRibbon = (run: GroundStyleRun) => isLines(run) && styleFadeProgress(run.zoomFade, zoom) > 0;
    const drawsVeiledRibbons = linedSources.some((s) => s.resident.gpu.ground.runs.some((run) => (run.flags & GroundStyleRunFlag.sphereVeiled) !== 0 && isVisibleRibbon(run)));
    if (drawsVeiledRibbons) {
      select("ribbonCores");
      for (const s of linedSources) drawSpans(s, highestRankFirstSpans(s.resident.gpu.ground, isVisibleRibbon));
    }
    select(drawsVeiledRibbons ? "ribbonFeathers" : "ribbons");
    for (const s of linedSources) drawSpans(s, visibleRunSpans(s.resident.gpu.ground, zoom, isLines));
  }

  private bindSource(pass: GPURenderPassEncoder, source: GlobeSurfaceSource, layer: GpuGeometryLayer): void {
    pass.setBindGroup(2, layer.styles!);
    pass.setVertexBuffer(0, source.resident.gpu.buffer, layer.vertexOffset, layer.vertexCount * 16);
    pass.setIndexBuffer(source.resident.gpu.buffer, layer.indexFormat, layer.indexOffset, layer.indexCount * (layer.indexFormat === "uint16" ? 2 : 4));
    // The tile-priority reference, the source's zoom: every pass tests equal to the planner's marks.
    pass.setStencilReference(source.stencilReference);
  }

  /**
   * The draw's record: the source's place on the sphere in the first row,
   * and the flat path's dash anchor with the source tile's world size on
   * the equator, so the pattern holds still under camera motion and matches
   * the plane at the surface swap.
   */
  private writeDraw(frame: GlobeSurfaceFrame, source: GlobeSurfaceSource): number {
    const tile = source.resident.tile;
    const record = frame.drawParameters.allocate();
    const f = frame.drawParameters.f32;
    GlobeSurfaceTile.write(f, record.index, tile);
    const sourceTileWorldSize = frame.renderMapSize / 2 ** tile.z;
    f[record.index + 19] = GlobeLineDashScale.coarseTileDashScale(tile.z) * frame.pixelsPerPoint * lineDashUnitsPerPixel(sourceTileWorldSize, frame.drawHeightPx);
    return record.instance;
  }
}

/**
 * One span per run passing `filter`, from the highest rank down: the order
 * the ribbon cores draw in, each run's depth written before the next lower
 * rank is tested against it.
 */
export function highestRankFirstSpans(layer: GpuGeometryLayer, filter: (run: GroundStyleRun) => boolean): [number, number][] {
  if (layer.indexCount === 0) return [];
  const spans: [number, number][] = [];
  for (let index = layer.runs.length - 1; index >= 0; index--) {
    const run = layer.runs[index]!;
    if (run.indexCount > 0 && filter(run)) spans.push([run.indexStart, run.indexCount]);
  }
  return spans;
}
