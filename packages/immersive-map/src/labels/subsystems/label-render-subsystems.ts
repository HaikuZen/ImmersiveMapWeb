// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The labels' render subsystems (the Swift `BaseLabelPrepareSubsystem`,
 * `BaseLabelDrawSubsystem`, `RoadLabelDrawSubsystem`, `RendererLabelDrawer`
 * and `SurfaceLabelRenderSubsystem`):
 *
 * - `ScreenLabelSubsystem` decides the frame's screen labels on the CPU in
 *   `update` (`BaseLabelPrepare`), uploads their records in `prepareGPU` and
 *   draws them in the overlay pass: the POIs' discs, the route plates, the
 *   names, then the road names.
 * - `SurfaceLabelSubsystem` picks the copy of each label painted on the map
 *   that draws (`SurfaceLabelSelection`) and draws it in the world pass, on
 *   the flat map, the sphere and through the unroll, halos first.
 *
 * Every draw takes a record of the frame's draw parameters (decision B6):
 * its style and its tile's first label ride in the record, so a run of a
 * tile is one draw with no uniform write.
 */

import type { RoadLabelSceneInput } from "../drawers/label-gpu.ts";
import type { ViewMode } from "../../camera/view-mode.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { GlobeSphereVertexPath, GlobeSurfaceTile } from "../../globe/globe-frame-constants.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { RenderLayer, RenderPassAvailability } from "../../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../../render/frame-engine.ts";
import type { LabelOpacityFrame } from "../../style/theme.ts";
import type { PlaceTile } from "../../tile/placement/place-tile.ts";
import type { PreparedLabelTextStyle, RouteShieldRunStyle } from "../../tile/store/prepared-labels.ts";
import { LabelFrameRecordLayout, type LabelSourceTile } from "../base/base-label-cache.ts";
import { colorAtHandover, labelOpacityOf } from "../common/label-text-style.ts";
import type { LabelGpu } from "../drawers/label-gpu.ts";
import { SurfaceLabelDepth, SurfaceLabelScale, SurfaceLabelSelection, type SurfaceLabelSource } from "../surface/surface-label-selection.ts";
import { type BaseLabelPrepare, type LabelFrameInput, RoadGlyphRecordLayout } from "./base-label-prepare.ts";

/** What the label drawers read of a frame besides the decisions. */
export interface LabelDrawFrame {
  /** The drawable's orthographic matrix, pixels with the origin at the bottom left. */
  readonly screenMatrix: Float64Array;
  /** How far the globe's look of the names has been handed over to the plane's: 1 on the plane. */
  readonly handover: number;
  readonly labelOpacity: LabelOpacityFrame;
  /** The world the road names hide behind, set on the frames that keep its depth. */
  readonly roadScene?: RoadLabelSceneInput | undefined;
}

const routeShieldShapes = { rectangle: 0, capsule: 1, escutcheon: 2 } as const;

/** Writes a text style into a draw record at float `i`: fill, halo, halo width and fill bias in pixels, opacity, halo softness. */
function writeTextStyle(f: Float32Array, i: number, style: PreparedLabelTextStyle, handover: number, pixelsPerPoint: number, opacity: number): void {
  const fill = colorAtHandover(style.sphereFillColor, style.fillColor, handover);
  const stroke = colorAtHandover(style.sphereStrokeColor, style.strokeColor, handover);
  f[i] = fill[0];
  f[i + 1] = fill[1];
  f[i + 2] = fill[2];
  f[i + 3] = 1;
  f[i + 4] = stroke[0];
  f[i + 5] = stroke[1];
  f[i + 6] = stroke[2];
  f[i + 7] = 1;
  f[i + 12] = style.haloEm * style.sizePoints * pixelsPerPoint;
  f[i + 13] = style.emboldenPoints * pixelsPerPoint;
  f[i + 14] = opacity;
  f[i + 15] = Math.min(Math.max(style.haloSoftness, 0), 1);
}

/** The screen labels: the frame's decisions, their upload and their draws in the overlay. */
export class ScreenLabelSubsystem implements RenderSubsystem {
  readonly name = "ScreenLabels";
  readonly layers: readonly RenderLayer[] = ["labels"];

  constructor(
    private readonly gpu: LabelGpu,
    readonly prepare: BaseLabelPrepare,
    private readonly input: () => LabelFrameInput | undefined,
    private readonly drawFrame: () => LabelDrawFrame | undefined,
  ) {}

  update(): void {
    const input = this.input();
    if (input !== undefined) this.prepare.update(input);
  }

  contributeAvailability(availability: RenderPassAvailability): void {
    if (this.prepare.hasRenderableLabels) availability.labelsEnabled = true;
  }

  prepareGPU(context: FrameContext): void {
    const draw = this.drawFrame();
    if (draw === undefined || !this.prepare.hasRenderableLabels) return;
    const base = this.prepare.baseCache;
    // The test runs only on a frame whose world depth was kept for the labels.
    this.gpu.writeScene(context.sceneDepth !== undefined ? draw.roadScene : undefined);
    this.gpu.writeFrame(
      draw.screenMatrix,
      context.pixelsPerPoint,
      base.frameRecords,
      base.labelCount * LabelFrameRecordLayout.floats,
      this.prepare.roadGlyphRecords,
      this.prepare.roadGlyphCount * RoadGlyphRecordLayout.floats,
    );
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const draw = this.drawFrame();
    if (layer !== "labels" || draw === undefined || !this.prepare.hasRenderableLabels) return;
    pass.setBindGroup(0, this.gpu.frameBindGroup());
    pass.setBindGroup(3, this.gpu.sceneBindGroup(context.sceneDepth));
    this.encodeBaseLabels(pass, context, draw);
    this.encodeRoadLabels(pass, context, draw);
  }

  /**
   * The base labels, the POIs' discs first, then the route plates over them,
   * then every name's text over both: a sign's number is a glyph run of its
   * own and draws over its plate with the rest of the text.
   */
  private encodeBaseLabels(pass: GPURenderPassEncoder, context: FrameContext, draw: LabelDrawFrame): void {
    const batches = this.prepare.baseCache.drawBatches;
    if (this.prepare.baseCache.labelCount === 0) return;
    const parameters = context.drawParameters;
    const ppp = context.pixelsPerPoint;
    let boundGroup: GPUBindGroup | undefined;
    let boundAtlas: GPUBindGroup | undefined;
    const bind = (atlas: GPUBindGroup): void => {
      const group = drawLayoutOf(parameters, this.gpu);
      if (group !== boundGroup) pass.setBindGroup(1, (boundGroup = group));
      if (atlas !== boundAtlas) pass.setBindGroup(2, (boundAtlas = atlas));
    };

    pass.setPipeline(this.gpu.screenPipeline("poi"));
    for (const batch of batches) {
      const styles = batch.gpu.meta.labels.text.poiIconRunStyles;
      batch.gpu.labels.poiIconRuns.forEach((run, index) => {
        if (run.vertexCount === 0) return;
        const style = styles[index]!;
        const record = parameters.allocate();
        const f = parameters.f32;
        const i = record.index;
        f[i] = style.fillColor[0];
        f[i + 1] = style.fillColor[1];
        f[i + 2] = style.fillColor[2];
        f[i + 3] = 1;
        f[i + 4] = f[i + 5] = f[i + 6] = f[i + 7] = 1;
        f[i + 14] = labelOpacityOf(style, draw.labelOpacity);
        parameters.i32[i + 16] = batch.globalLabelStart;
        bind(this.gpu.atlasGroups.poi);
        pass.setVertexBuffer(0, batch.gpu.buffer, run.vertexOffset, run.vertexCount * 32);
        pass.draw(run.vertexCount, 1, 0, record.instance);
      });
    }

    pass.setPipeline(this.gpu.screenPipeline("routeShield"));
    for (const batch of batches) {
      const styles = batch.gpu.meta.labels.text.routeShieldRunStyles;
      batch.gpu.labels.routeShieldRuns.forEach((run, index) => {
        if (run.vertexCount === 0) return;
        const record = parameters.allocate();
        writeRouteShieldStyle(parameters.f32, record.index, styles[index]!);
        parameters.i32[record.index + 16] = batch.globalLabelStart;
        bind(this.gpu.atlasGroups.poi);
        pass.setVertexBuffer(0, batch.gpu.buffer, run.vertexOffset, run.vertexCount * 32);
        pass.draw(run.vertexCount, 1, 0, record.instance);
      });
    }

    pass.setPipeline(this.gpu.screenPipeline("text"));
    for (const batch of batches) {
      const styles = batch.gpu.meta.labels.text.glyphRunStyles;
      batch.gpu.labels.glyphRuns.forEach((run, index) => {
        if (run.vertexCount === 0) return;
        const style = styles[index]!;
        const record = parameters.allocate();
        // The colours are the globe's look of the label handed over to the plane's with the air.
        writeTextStyle(parameters.f32, record.index, style, draw.handover, ppp, labelOpacityOf(style, draw.labelOpacity));
        parameters.i32[record.index + 16] = batch.globalLabelStart;
        bind(this.gpu.atlasGroups[style.weight]);
        pass.setVertexBuffer(0, batch.gpu.buffer, run.vertexOffset, run.vertexCount * 32);
        pass.draw(run.vertexCount, 1, 0, record.instance);
      });
    }
  }

  /** The road names, one draw per road tile, after the base labels. */
  private encodeRoadLabels(pass: GPURenderPassEncoder, context: FrameContext, draw: LabelDrawFrame): void {
    const draws = this.prepare.roadDraws;
    if (draws.length === 0) return;
    const parameters = context.drawParameters;
    pass.setPipeline(this.gpu.screenPipeline("roadText"));
    let boundGroup: GPUBindGroup | undefined;
    let boundAtlas: GPUBindGroup | undefined;
    for (const { record, glyphShift } of draws) {
      const style = record.labelStyle;
      const entry = parameters.allocate();
      writeTextStyle(parameters.f32, entry.index, style, 1, context.pixelsPerPoint, labelOpacityOf(style, draw.labelOpacity));
      parameters.i32[entry.index + 16] = glyphShift;
      const group = drawLayoutOf(parameters, this.gpu);
      if (group !== boundGroup) pass.setBindGroup(1, (boundGroup = group));
      const atlas = this.gpu.atlasGroups[style.weight];
      if (atlas !== boundAtlas) pass.setBindGroup(2, (boundAtlas = atlas));
      const glyphs = record.glyphVertices;
      pass.setVertexBuffer(0, record.resident.gpu.buffer, glyphs.vertexOffset, glyphs.vertexCount * 32);
      pass.draw(glyphs.vertexCount, 1, 0, entry.instance);
    }
  }
}

/** The draw-parameter group for the label pipelines' layout. */
function drawLayoutOf(parameters: FrameContext["drawParameters"], gpu: LabelGpu): GPUBindGroup {
  return parameters.bindGroup(gpu.drawLayout);
}

/** Writes a route plate style: fill, border, band, border width, corner radius, band share, shape (the Swift `RouteShieldStyleUniform`). */
function writeRouteShieldStyle(f: Float32Array, i: number, style: RouteShieldRunStyle): void {
  const header = style.headerColor ?? style.fillColor;
  f[i] = style.fillColor[0];
  f[i + 1] = style.fillColor[1];
  f[i + 2] = style.fillColor[2];
  f[i + 3] = 1;
  f[i + 4] = style.borderColor[0];
  f[i + 5] = style.borderColor[1];
  f[i + 6] = style.borderColor[2];
  f[i + 7] = 1;
  f[i + 8] = header[0];
  f[i + 9] = header[1];
  f[i + 10] = header[2];
  f[i + 11] = 1;
  f[i + 12] = style.borderWidthPoints;
  f[i + 13] = style.cornerRadiusPoints;
  f[i + 14] = style.headerColor === null ? 0 : style.headerFraction;
  f[i + 15] = routeShieldShapes[style.shape];
}

/** What the surface labels read of a frame. */
export interface SurfaceLabelFrame {
  readonly placements: readonly PlaceTile<LabelSourceTile>[];
  readonly renderSurfaceMode: ViewMode;
  readonly flatRenderState: FlatRenderState;
  readonly globe: GlobeUniform;
  /** The map's size over its integer zoom's tile count: every tile at its own zoom has this world size. */
  readonly tileWorldSize: number;
  readonly handover: number;
  readonly labelOpacity: LabelOpacityFrame;
  /** Atlas texels per em of each weight's atlas. */
  readonly atlasEmTexels: { readonly bold: number; readonly thin: number };
}

interface SurfaceDrawItem {
  readonly resident: LabelSourceTile;
  readonly worldWrap: number;
  readonly recordIndex: number;
}

/** The labels painted on the map, in the world pass after the ground and its roads. A label shows whole or not at all. */
export class SurfaceLabelSubsystem implements RenderSubsystem {
  readonly name = "SurfaceLabels";
  readonly layers: readonly RenderLayer[] = ["surfaceLabels"];
  private items: SurfaceDrawItem[] = [];

  constructor(
    private readonly gpu: LabelGpu,
    private readonly state: () => SurfaceLabelFrame | undefined,
  ) {}

  update(context: FrameContext): void {
    const frame = this.state();
    if (frame === undefined) {
      this.items = [];
      return;
    }
    // One source per tile and world copy. The sphere has one world, so its placements' wrap is not part of a source there.
    const wrapsWorld = frame.renderSurfaceMode === "flat";
    const seen = new Set<string>();
    const sources: { resident: LabelSourceTile; worldWrap: number }[] = [];
    for (const placement of frame.placements) {
      if (!placement.rules.drawsLabels || placement.resident.gpu.meta.labels.surface.length === 0) continue;
      const worldWrap = wrapsWorld ? placement.placeIn.worldWrap : 0;
      const t = placement.resident.tile;
      const key = `${t.z}/${t.x}/${t.y}@${worldWrap}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ resident: placement.resident, worldWrap });
    }
    const selectionSources: SurfaceLabelSource[] = sources.map((s) => ({ labels: s.resident.gpu.meta.labels.surface, tileZoom: s.resident.tile.z, worldWrap: s.worldWrap }));
    this.items = SurfaceLabelSelection.select(selectionSources, context.planningZoom).map((item) => ({
      resident: sources[item.sourceIndex]!.resident,
      worldWrap: sources[item.sourceIndex]!.worldWrap,
      recordIndex: item.labelIndex,
    }));
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const frame = this.state();
    if (layer !== "surfaceLabels" || frame === undefined || this.items.length === 0) return;
    const flat = frame.renderSurfaceMode === "flat";
    const surface = flat ? "flat" : GlobeSphereVertexPath.isPureSphere(frame.renderSurfaceMode, frame.globe.transition) ? "sphere" : "morph";
    pass.setPipeline(this.gpu.surfacePipeline(surface));
    pass.setBindGroup(0, context.frameBindGroup);
    const parameters = context.drawParameters;
    const viewportHeightPoints = context.drawHeight / Math.max(context.pixelsPerPoint, 1);
    const tileScreenPoints = SurfaceLabelScale.tileScreenPoints(viewportHeightPoints, frame.tileWorldSize);
    const handover = flat ? 1 : frame.handover;
    let boundGroup: GPUBindGroup | undefined;
    let boundAtlas: GPUBindGroup | undefined;
    // Every halo first, then every fill: where two names cross, the halo of one never covers the letters of the other.
    for (const haloPass of [true, false]) {
      for (const item of this.items) {
        const record = item.resident.gpu.meta.labels.surface[item.recordIndex]!;
        const style = record.style;
        const haloAtlasTexels = style.haloEm * frame.atlasEmTexels[style.weight];
        if (record.vertexCount === 0 || (haloPass && haloAtlasTexels <= 0)) continue;
        const entry = parameters.allocate();
        const f = parameters.f32;
        const i = entry.index;
        const tile = item.resident.tile;
        if (flat) {
          const [x, y, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, item.worldWrap, frame.flatRenderState.pan, frame.flatRenderState.renderMapSize);
          f[i] = x;
          f[i + 1] = y;
          f[i + 2] = size / 4096;
        } else {
          GlobeSurfaceTile.write(f, i, tile);
        }
        const opacity = labelOpacityOf(style, frame.labelOpacity);
        const fill = colorAtHandover(style.sphereFillColor, style.fillColor, handover);
        const stroke = colorAtHandover(style.sphereStrokeColor, style.strokeColor, handover);
        f[i + 4] = fill[0];
        f[i + 5] = fill[1];
        f[i + 6] = fill[2];
        f[i + 7] = opacity;
        f[i + 8] = stroke[0];
        f[i + 9] = stroke[1];
        f[i + 10] = stroke[2];
        f[i + 11] = opacity;
        f[i + 12] = haloAtlasTexels;
        f[i + 13] = haloPass ? 1 : 0;
        f[i + 14] = SurfaceLabelScale.tileUnitsPerPoint(tile.z, record.placement.referenceZoom, tileScreenPoints);
        f[i + 15] = Math.min(Math.max(style.haloSoftness, 0), 1);
        f[i + 16] = context.drawWidth;
        f[i + 17] = context.drawHeight;
        f[i + 18] = context.pixelsPerPoint;
        f[i + 19] = SurfaceLabelDepth.depth;
        const group = parameters.bindGroup(this.gpu.drawLayout);
        if (group !== boundGroup) pass.setBindGroup(1, (boundGroup = group));
        const atlas = this.gpu.atlasGroups[style.weight];
        if (atlas !== boundAtlas) pass.setBindGroup(2, (boundAtlas = atlas));
        const span = item.resident.gpu.labels.surfaceGlyphs;
        pass.setVertexBuffer(0, item.resident.gpu.buffer, span.vertexOffset, span.vertexCount * 32);
        pass.draw(record.vertexCount, 1, record.vertexStart, entry.instance);
      }
    }
  }
}
