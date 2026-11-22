// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The `layers` folder: the layers of the app's own data drawn over the map
 * (`ImmersiveMapLayer`), from the public model and its GeoJSON to the
 * registered sources (`sources/`, `LayerSourceLibrary`), the worker that reads
 * them and builds the meshes in Rust (`worker/`, crates/layer-mesh), the
 * meshes on the GPU (`LayerMeshStore`) and on disk (`cache/`), the selection
 * (`selection/`), the pipelines and the shaders, and this subsystem, the port
 * of the Swift `Layers` folder. The data comes in through one seam,
 * `LayerRenderSource`, read every frame: the app's controller behind the map
 * (`ImmersiveMapLayersController`). Nothing here knows the map's tiles, its
 * schema or its style, and nothing of the layers is configuration:
 * `ImmersiveMapSettings` holds none of it.
 */

import type { ViewMode } from "../camera/view-mode.ts";
import type { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { GlobeSphereVertexPath, GlobeSurfaceTile } from "../globe/globe-frame-constants.ts";
import type { GlobeUniform } from "../globe/globe-uniform.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { FlatRenderState } from "../presentation/resolved-presentation-state.ts";
import type { RenderLayer, RenderPassAvailability } from "../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import type { LayerMeshChunk } from "./cache/layer-mesh-file.ts";
import { ImmersiveMapLayer } from "./immersive-map-layer.ts";
import { LayerChunkCulling } from "./layer-chunk-culling.ts";
import type { LayerMesh, LayerMeshStore } from "./layer-mesh-store.ts";
import { LAYER_CORNER_SLOTS, LAYER_LINE_TEMPLATE, LayerDepth, type LayerPipeline, type LayerSurface } from "./layer-pipeline.ts";
import type { LayerRenderSource } from "./layer-render-source.ts";
import { type LayerSelectionEntry, LayerSelectionSnapshot } from "./selection/layer-selection-snapshot.ts";

/** What the layers read of the frame being drawn. */
export interface LayerFrame {
  readonly renderSurfaceMode: ViewMode;
  readonly flatRenderState: FlatRenderState;
  /** The globe the sphere's draws project by: its geometry transition is the morph's. */
  readonly globe: GlobeUniform;
  /** The world x (0 to 1) of the point the camera looks at: a chunk draws in the copy of the world nearest it. */
  readonly centerWorldX: number;
  /** The CPU projection-view matrix (column-major), what the chunks are culled by. */
  readonly projectionView: Mat4;
  /** Whether the ground rises on the relief this frame: a layer that hides behind the terrain then lies in the relief's depth band. */
  readonly reliefActive: boolean;
  /** The frame's projection for a tap's test, made only when the layers' shapes are kept for taps. */
  readonly pickProjection: () => GeoScreenProjectionFrameConstants;
}

interface DrawnLayer {
  readonly mesh: LayerMesh;
  readonly hidesBehindTerrain: boolean;
}

const placementScratch = new Float64Array(16);

/**
 * Draws the layers on the ground of whichever surface the frame shows, in a
 * render layer of their own (`appLayers`), the Swift `LayerRenderSubsystem`:
 * after the flat map's roads and the trees' shadows, after the globe's
 * ground, so the labels painted on the map come over them on both. A frame
 * with no layer to draw leaves the render layer out. A layer draws its
 * zones, then its lines, then the joins of its single vertex lines, then its
 * points, the layers in the order they are set. On the flat map a chunk
 * draws in the copy of the world nearest the camera, and in its neighbours
 * too at the zooms that show more than one, and a chunk outside the view is
 * not drawn (`LayerChunkCulling`). On the globe every chunk is drawn, and
 * the far side is cut on the GPU. A layer is not tested against the
 * ground's depth unless it asks to be (`hidesBehindTerrain`): the buildings,
 * the models and the trees cover it through the surface mask bit they raise
 * in the stencil.
 */
export class LayerRenderSubsystem implements RenderSubsystem {
  readonly name = "Layers";
  readonly layers: readonly RenderLayer[] = ["appLayers"];
  /** The camera zoom under which the flat map can show more than one copy of the world across the view. */
  static readonly wrappedCopiesBelowZoom = 4;

  private drawn: DrawnLayer[] = [];
  private snapshot = LayerSelectionSnapshot.empty;
  /** The layers the frame draws whose meshes are still on their way (the Swift `pendingLayerMeshes` counter). */
  pendingCount = 0;
  /** The layers the last frame drew, and their draws. */
  drawnLayerCount = 0;
  drawCount = 0;

  constructor(
    private readonly pipeline: LayerPipeline,
    private readonly store: LayerMeshStore,
    private readonly source: () => LayerRenderSource | undefined,
    private readonly frame: () => LayerFrame | undefined,
    /** Whether a tap is tested against the layers: their shapes are kept and the frame's projection with them. */
    private readonly picksWanted: () => boolean,
    /** A frame is wanted: the pipelines were compiled. */
    private readonly onReady: () => void,
  ) {}

  /** What a tap can land on, of the last frame: the layers it drew whose shapes are at hand. */
  get pickData(): LayerSelectionSnapshot {
    return this.snapshot;
  }

  update(context: FrameContext): void {
    const source = this.source();
    const layers = source?.currentLayers ?? [];
    const zoom = context.planningZoom;
    this.drawnLayerCount = 0;
    this.drawCount = 0;
    const { meshes, contents, pendingCount } = this.store.meshes(layers, zoom, source?.sourceLibrary);
    // For whoever waits for a settled scene (a still capture): a source is
    // read and a mesh is built off the main thread, and neither raises an
    // activity, so nothing else says the layers are not all drawn as set.
    this.pendingCount = pendingCount;
    const drawn: DrawnLayer[] = [];
    layers.forEach((layer, index) => {
      const mesh = meshes[index];
      if (!ImmersiveMapLayer.draws(layer, zoom) || mesh === undefined || mesh.chunks.length === 0) return;
      drawn.push({ mesh, hidesBehindTerrain: layer.hidesBehindTerrain });
    });
    this.drawn = drawn;
    if (drawn.length > 0 && !this.pipeline.isReady) this.pipeline.prepare(this.onReady);
    // An empty snapshot too: a layer that stops being drawn stops being tappable.
    const entries: LayerSelectionEntry[] = [];
    if (this.picksWanted()) {
      layers.forEach((layer, index) => {
        const content = contents[index];
        if (ImmersiveMapLayer.draws(layer, zoom) && meshes[index] !== undefined && content !== undefined) entries.push({ layer, content });
      });
    }
    const frame = this.frame();
    const projection = entries.length > 0 && frame !== undefined ? frame.pickProjection() : undefined;
    this.snapshot = new LayerSelectionSnapshot(context.frameNumber, context.drawWidth, context.drawHeight, projection, entries);
  }

  contributeAvailability(availability: RenderPassAvailability): void {
    availability.appLayersEnabled = availability.appLayersEnabled || (this.drawn.length > 0 && this.pipeline.isReady);
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const frame = this.frame();
    if (layer !== "appLayers" || frame === undefined || this.drawn.length === 0) return;
    const surface: LayerSurface =
      frame.renderSurfaceMode === "flat" ? "flat" : GlobeSphereVertexPath.isPureSphere(frame.renderSurfaceMode, frame.globe.transition) ? "sphere" : "morph";
    pass.setBindGroup(0, context.frameBindGroup);
    pass.setStencilReference(0);
    const parameters = context.drawParameters;
    let boundGroup: GPUBindGroup | undefined;
    const placements = this.chunkPlacements(frame, surface, context);

    for (const { mesh, hidesBehindTerrain } of this.drawn) {
      const states = this.pipeline.statesFor(surface, hidesBehindTerrain);
      if (states === undefined) continue;
      // On the relief a layer that hides behind the terrain lies in the relief's band.
      const reliefBand = hidesBehindTerrain && surface === "flat" && frame.reliefActive;
      // Each chunk with its draw records of this frame, none for a chunk outside the view.
      const chunks: { chunk: LayerMeshChunk; records: number[] }[] = [];
      for (const chunk of mesh.chunks) {
        const records = placements(chunk, (f, i) => {
          f[i + 8] = reliefBand ? 1 : 0;
        });
        if (records.length > 0) chunks.push({ chunk, records });
      }
      if (chunks.length === 0) continue;
      const group = parameters.bindGroup(this.pipeline.context.drawLayout);
      if (group !== boundGroup) pass.setBindGroup(1, (boundGroup = group));
      this.drawnLayerCount++;

      if (mesh.fillVertices !== undefined && mesh.fillIndices !== undefined) {
        pass.setPipeline(states.fill);
        pass.setVertexBuffer(0, mesh.fillVertices);
        pass.setIndexBuffer(mesh.fillIndices, "uint32");
        for (const { chunk, records } of chunks) {
          if (chunk.fillIndexCount === 0) continue;
          for (const record of records) {
            pass.drawIndexed(chunk.fillIndexCount, 1, chunk.fillIndexStart, 0, record);
            this.drawCount++;
          }
        }
      }
      if (mesh.lineSegments !== undefined) {
        pass.setPipeline(states.line);
        pass.setVertexBuffer(0, mesh.lineSegments);
        pass.setIndexBuffer(this.pipeline.lineTemplateIndices, "uint16");
        for (const { chunk, records } of chunks) {
          if (chunk.lineCount === 0) continue;
          for (const record of records) {
            pass.drawIndexed(LAYER_LINE_TEMPLATE.length, chunk.lineCount, 0, record * LAYER_CORNER_SLOTS, chunk.lineStart);
            this.drawCount++;
          }
        }
      }
      if (mesh.discs !== undefined) {
        pass.setPipeline(states.point);
        pass.setVertexBuffer(0, mesh.discs);
        // The lines of a single vertex with the lines, then the points over them.
        for (const joins of [true, false]) {
          for (const { chunk, records } of chunks) {
            const start = joins ? chunk.joinStart : chunk.pointStart;
            const count = joins ? chunk.joinCount : chunk.pointCount;
            if (count === 0) continue;
            for (const record of records) {
              pass.draw(6, count, record * LAYER_CORNER_SLOTS, start);
              this.drawCount++;
            }
          }
        }
      }
    }
  }

  /**
   * The draw records of a chunk this frame: one per copy of the world it
   * draws in on the flat map and shows in (`LayerChunkCulling`), one on the
   * globe. `fill` writes the layer's own fields of a record.
   */
  private chunkPlacements(
    frame: LayerFrame,
    surface: LayerSurface,
    context: FrameContext,
  ): (chunk: LayerMeshChunk, fill: (f: Float32Array, index: number) => void) => number[] {
    const parameters = context.drawParameters;
    const { drawWidth, drawHeight, pixelsPerPoint } = context;
    const record = (write: (f: Float32Array, index: number) => void, fill: (f: Float32Array, index: number) => void): number => {
      const entry = parameters.allocate();
      const f = parameters.f32;
      write(f, entry.index);
      f[entry.index + 4] = drawWidth;
      f[entry.index + 5] = drawHeight;
      f[entry.index + 6] = pixelsPerPoint;
      f[entry.index + 7] = LayerDepth.depth;
      fill(f, entry.index);
      return entry.instance;
    };
    if (surface !== "flat") {
      return (chunk, fill) => [record((f, i) => GlobeSurfaceTile.write(f, i, chunk), fill)];
    }
    const { pan, renderMapSize } = frame.flatRenderState;
    const copies = context.planningZoom < LayerRenderSubsystem.wrappedCopiesBelowZoom ? [-1, 0, 1] : [0];
    const camera = frame.projectionView;
    return (chunk, fill) => {
      const count = 2 ** chunk.z;
      const centreX = (chunk.x + 0.5) / count;
      const nearest = Math.round(frame.centerWorldX - centreX);
      const records: number[] = [];
      for (const offset of copies) {
        const [x, y, size] = ImmersiveMapProjection.flatTileOriginAndSize(chunk.x, chunk.y, chunk.z, nearest + offset, pan, renderMapSize);
        const scale = size / 4096;
        // The camera's matrix by the chunk's: a scale by `scale` and a move to the origin.
        const m = placementScratch;
        for (let r = 0; r < 4; r++) {
          m[r] = camera[r]! * scale;
          m[4 + r] = camera[4 + r]! * scale;
          m[8 + r] = camera[8 + r]!;
          m[12 + r] = camera[r]! * x + camera[4 + r]! * y + camera[12 + r]!;
        }
        if (!LayerChunkCulling.isVisible(chunk.boundsMinimum, chunk.boundsMaximum, m, chunk.maximumReachPoints * pixelsPerPoint, drawWidth, drawHeight)) continue;
        records.push(
          record((f, i) => {
            f[i] = x;
            f[i + 1] = y;
            f[i + 2] = scale;
            f[i + 3] = 0;
          }, fill),
        );
      }
      return records;
    };
  }

  /** The layers that are not drawn give back their meshes and their sources' shapes. */
  handleMemoryWarning(): void {
    this.store.releaseUndrawn();
  }

  destroy(): void {
    this.store.destroy();
    this.pipeline.destroy();
    this.drawn = [];
    this.snapshot = LayerSelectionSnapshot.empty;
  }
}
