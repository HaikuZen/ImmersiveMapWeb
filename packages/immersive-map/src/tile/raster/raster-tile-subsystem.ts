// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The ground of the raster targets, a port of the Swift
 * `RasterTileRenderSubsystem` (the plane): the slots of a ring rule with a
 * raster size (`VisibleContentState.rasterTiles`) show their tile's ground
 * through a texture. A tile placed in a raster slot has its fills drawn
 * into a texture of the slot's size (`prepareGPU`, before the world pass,
 * the zoom fades at the planning zoom as the vector ground draws them,
 * then the mip chain), and the world pass draws the texture on the tile's
 * grid (`RasterTileGrid`), first in the ground's layer.
 *
 * A tile keeps its texture from frame to frame and is drawn into it again
 * only when what the texture shows would change (`RasterTextureCache`):
 * another tile object in the slot (a new load of it), another size, or a
 * fade of one of its styles moved at the planning zoom
 * (`rasterBakeSignature`). A pan or a camera at rest draws no texture at
 * all. The tiles drawn again in a frame are drawn in one pass, each in its
 * own window of one shared atlas (`rasterAtlasPages`), multisampled and
 * resolved, and copied from there into their textures, whose mip chains
 * are drawn after.
 *
 * A texture is opaque and owns its pixels as an opaque fill does: it writes
 * a depth half a rank step behind the ground's first, so the lines drawn
 * over it pass and a vector tile drawn over it wins outright
 * (tile-raster.wgsl), and it paints the ground the planner gave its tile,
 * drawn at full extent under the tile-priority stencil
 * (`TileSourceStencilPriority`). Its order against the vector ground does
 * not matter: a source is a texture or geometry in a frame, never both,
 * and the stencil keeps every source on its own ground.
 *
 * On the sphere and through the unroll the texture draws in the globe's
 * ground layer, once per source (the sphere has one copy of the world), on
 * the grid projected as the vector ground is (tile-raster-sphere.wgsl), at
 * the ground's first rank, under the globe's light.
 *
 * On the ground relief, where the frame is on it, a placement whose
 * terrain is in draws raised as the vector ground is (tile-raster.wgsl,
 * `kTileRasterRelief`), on a grid as fine as the terrain and its raster can
 * show (`RasterTileGrid.reliefCells`), its slopes shaded by the placement's
 * terrain. The horizon backdrop lies under the relief, at the lowest height
 * of the frame's terrain (`backdropFloorLift`).
 */

import type { Rgba } from "../../configuration/color.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { RenderLayer } from "../../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../../render/frame-engine.ts";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import { type FlatResidentTile, visibleRunSpans } from "../drawers/flat-map-surface-drawer.ts";
import { GroundStyleRunFlag, type GroundStyleRun } from "../store/tile-gpu.ts";
import { GlobeSphereVertexPath, GlobeSurfaceTile } from "../../globe/globe-frame-constants.ts";
import type { TileFrameState } from "../subsystems/flat-tile-subsystems.ts";
import { rasterAtlasPages, grownRasterAtlasSize } from "./raster-tile-atlas.ts";
import { RasterTileGrid, RasterTileGridMeshes, type RasterTileGridMesh } from "./raster-tile-grid.ts";
import { RASTER_TILE_BAKE_SAMPLE_COUNT, RASTER_TILE_TEXTURE_FORMAT, type RasterTilePipeline } from "./raster-tile-pipeline.ts";
import { rasterBakeSignature, rasterSources, type RasterSource } from "./raster-tile-sources.ts";
import { RasterTextureCache } from "./raster-tile-texture-cache.ts";
import { groundFlatteningGrid, type GroundFlatteningSettings } from "../../configuration/tile-settings.ts";
import type { GroundReliefFrame } from "../relief/frame/ground-relief-frame.ts";
import type { GroundReliefGpu } from "../relief/frame/ground-relief-gpu.ts";
import { TileCulling } from "../visibility/tile-culling.ts";
import { RasterTileTexture } from "./raster-tile-texture.ts";

/** One source of the frame with its texture, and whether the texture is drawn into this frame. */
interface FrameSource {
  readonly source: RasterSource<FlatResidentTile>;
  readonly texture: RasterTileTexture;
  readonly signature: number;
  readonly needsBake: boolean;
}

/** The atlas the frame's draws go through: multisampled and resolved, grown to the largest frame's need. */
interface BakeAtlas {
  readonly samples: GPUTexture;
  readonly resolved: GPUTexture;
  readonly samplesView: GPUTextureView;
  readonly resolvedView: GPUTextureView;
}

const isFillRun = (run: GroundStyleRun) => (run.flags & GroundStyleRunFlag.linesClass) === 0;

export class RasterTileSubsystem implements RenderSubsystem {
  readonly name = "RasterTiles";
  readonly layers: readonly RenderLayer[] = ["flatMapSurface", "globeVectorSurface"];

  private readonly grid: RasterTileGridMeshes;
  private readonly textures: RasterTextureCache<FlatResidentTile, RasterTileTexture>;
  /** The frame's sources, finest first. */
  private sources: FrameSource[] = [];
  private atlas: BakeAtlas | undefined;
  /**
   * The textures this frame's pass draws, recorded as drawn once the frame
   * is committed (`frameCommitted`): a frame dropped after its encoding
   * never ran its pass, and its tiles draw again.
   */
  private pendingBakes: { key: string; texture: RasterTileTexture; signature: number }[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: RasterTilePipeline,
    private readonly state: () => TileFrameState,
    /** The map's base colour (`ImmersiveMapBaseColors.map`): the ground of a texture under its fills. */
    private readonly mapBaseColor: () => Rgba,
    private readonly reliefGpu: GroundReliefGpu,
    private readonly groundFlattening: GroundFlatteningSettings,
  ) {
    this.grid = new RasterTileGridMeshes(device);
    this.textures = new RasterTextureCache(
      (size) => new RasterTileTexture(device, pipeline, size),
      (texture) => texture.destroy(),
    );
  }

  /** The frame's raster sources, each with its texture as last drawn or one to draw into. */
  update(context: FrameContext): void {
    this.pendingBakes = [];
    const sources = rasterSources(this.state().placements);
    const signatures = sources.map((s) => rasterBakeSignature(s.resident.gpu.ground.runs, context.planningZoom));
    const assignments = this.textures.assign(sources.map((source, i) => ({ key: source.key, resident: source.resident, size: source.size, signature: signatures[i]! })));
    this.sources = sources.map((source, i) => ({ source, texture: assignments[i]!.texture, signature: signatures[i]!, needsBake: assignments[i]!.needsBake }));
    // Out of the raster rings, the atlas goes with the textures.
    if (sources.length === 0) this.dropAtlas();
  }

  /**
   * Draws the fills of the sources whose texture must be drawn again this
   * frame, and only theirs, each in its own window of the atlas, through
   * the atlas's samples, resolved at the pass's end. Then each window is
   * copied into its tile's texture and the texture's mip chain is drawn.
   * The fades are the planning zoom's (the frame group's overview fade), as
   * the vector ground draws them. A frame that draws no texture encodes
   * nothing.
   */
  prepareGPU(context: FrameContext, encoder: GPUCommandEncoder): void {
    const drawn = this.sources.filter((s) => s.needsBake);
    if (drawn.length === 0) return;
    const pages = rasterAtlasPages(
      drawn.map((s) => s.source.size),
      this.device.limits.maxTextureDimension2D,
    );
    const atlas = this.ensureAtlas(
      pages.reduce((w, p) => Math.max(w, p.width), 0),
      pages.reduce((h, p) => Math.max(h, p.height), 0),
    );
    const base = this.mapBaseColor();
    for (const page of pages) {
      const pass = encoder.beginRenderPass({
        label: `raster tiles ${page.windows.length}`,
        colorAttachments: [
          {
            view: atlas.samplesView,
            resolveTarget: atlas.resolvedView,
            clearValue: { r: base[0], g: base[1], b: base[2], a: 1 },
            loadOp: "clear",
            // The samples live for the pass alone (the Swift memoryless atlas).
            storeOp: "discard",
          },
        ],
      });
      pass.setPipeline(this.pipeline.bake);
      pass.setBindGroup(0, context.frameBindGroup);
      for (const window of page.windows) {
        // The tile's extent fills its window: the clip volume is the
        // window, so nothing of a tile reaches its neighbour's.
        pass.setViewport(window.x, window.y, window.size, window.size, 0, 1);
        pass.setScissorRect(window.x, window.y, window.size, window.size);
        this.encodeFills(pass, drawn[window.index]!.source.resident, context.planningZoom);
      }
      pass.end();
      for (const window of page.windows) {
        const frameSource = drawn[window.index]!;
        encoder.copyTextureToTexture(
          { texture: atlas.resolved, origin: { x: window.x, y: window.y } },
          { texture: frameSource.texture.texture },
          [window.size, window.size],
        );
        frameSource.texture.encodeMips(encoder, this.pipeline);
        this.pendingBakes.push({ key: frameSource.source.key, texture: frameSource.texture, signature: frameSource.signature });
      }
    }
  }

  /** The frame's pass is on the GPU: its textures are drawn, from the signatures they were drawn from. */
  frameCommitted(): void {
    for (const bake of this.pendingBakes) this.textures.drawn(bake.key, bake.texture, bake.signature);
    this.pendingBakes = [];
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    if (this.sources.length === 0) return;
    const { renderSurfaceMode } = this.state();
    if (layer === "flatMapSurface" && renderSurfaceMode === "flat") this.encodeFlat(pass, context);
    else if (layer === "globeVectorSurface" && renderSurfaceMode === "spherical") this.encodeSphere(pass, context);
  }

  private encodeFlat(pass: GPURenderPassEncoder, context: FrameContext): void {
    const { flatRenderState, relief } = this.state();
    const reliefFrame = relief?.isActive === true ? relief : undefined;
    let selectedRelief: boolean | undefined;
    pass.setBindGroup(0, context.frameBindGroup);
    this.reliefGpu.bindEmpty(pass, 3);
    let boundDraws: GPUBindGroup | undefined;
    let boundMesh: RasterTileGridMesh | undefined;
    const floorLift = RasterTileSubsystem.backdropFloorLift(reliefFrame);
    for (const { source, texture } of this.sources) {
      const tile = source.resident.tile;
      pass.setBindGroup(2, texture.bindGroup);
      // The tile-priority value, the tile's zoom, tested equal to the planner's marks.
      pass.setStencilReference(TileSourceStencilPriority.reference(tile.z));
      for (const placement of source.placements) {
        // The world tile is the horizon backdrop, flat on the plane: no band
        // places a tile that coarse.
        const raised = reliefFrame !== undefined && tile.z > TileCulling.flatBackdropZoomLevel && placement.displacement !== undefined ? reliefFrame.relief(tile, placement.displacement) : undefined;
        const shading = raised !== undefined && placement.terrain !== undefined ? reliefFrame!.relief(tile, placement.terrain) : undefined;
        // As fine as the terrain and the raster can show, no finer.
        const cells = raised === undefined ? 0 : RasterTileGrid.reliefCells(groundFlatteningGrid(this.groundFlattening, tile.z), raised, source.size);
        const mesh = this.grid.forTileZoom(tile.z, cells);
        if (mesh !== boundMesh) {
          boundMesh = mesh;
          pass.setVertexBuffer(0, mesh.vertices);
          pass.setIndexBuffer(mesh.indices, mesh.indexFormat);
        }
        const isRaised = raised !== undefined;
        if (isRaised !== selectedRelief) {
          selectedRelief = isRaised;
          pass.setPipeline(isRaised ? this.pipeline.flatRelief : this.pipeline.flat);
        }
        if (raised !== undefined) this.reliefGpu.bind(pass, 3, raised, shading, tile, reliefFrame!, flatRenderState.renderMapSize);
        const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, placement.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
        const scale = size / 4096;
        const record = context.drawParameters.allocate();
        const f = context.drawParameters.f32;
        const i = record.index;
        f[i] = scale;
        f[i + 5] = scale;
        f[i + 10] = 1;
        f[i + 12] = ox;
        f[i + 13] = oy;
        // The horizon backdrop lies under the relief, at the lowest height of
        // the frame's terrain: on the plane the ground is drawn from it would
        // hang over the valleys below the point looked at.
        f[i + 14] = tile.z <= TileCulling.flatBackdropZoomLevel ? floorLift : 0;
        f[i + 15] = 1;
        const draws = context.drawParameters.bindGroup(this.pipeline.drawLayout);
        if (draws !== boundDraws) pass.setBindGroup(1, (boundDraws = draws));
        pass.drawIndexed(mesh.indexCount, 1, 0, 0, record.instance);
      }
    }
  }

  /**
   * The sphere has one copy of the world, and a tile draws whole at its own
   * place whatever slot it stands in: once per source.
   */
  private encodeSphere(pass: GPURenderPassEncoder, context: FrameContext): void {
    const { renderSurfaceMode, globe } = this.state();
    pass.setPipeline(this.pipeline.sphere(!GlobeSphereVertexPath.isPureSphere(renderSurfaceMode, globe.transition)));
    pass.setBindGroup(0, context.frameBindGroup);
    let boundDraws: GPUBindGroup | undefined;
    let boundMesh: RasterTileGridMesh | undefined;
    for (const { source, texture } of this.sources) {
      const tile = source.resident.tile;
      pass.setBindGroup(2, texture.bindGroup);
      pass.setStencilReference(TileSourceStencilPriority.reference(tile.z));
      const mesh = this.grid.forTileZoom(tile.z);
      if (mesh !== boundMesh) {
        boundMesh = mesh;
        pass.setVertexBuffer(0, mesh.vertices);
        pass.setIndexBuffer(mesh.indices, mesh.indexFormat);
      }
      const record = context.drawParameters.allocate();
      GlobeSurfaceTile.write(context.drawParameters.f32, record.index, tile);
      const draws = context.drawParameters.bindGroup(this.pipeline.drawLayout);
      if (draws !== boundDraws) pass.setBindGroup(1, (boundDraws = draws));
      pass.drawIndexed(mesh.indexCount, 1, 0, 0, record.instance);
    }
  }

  /**
   * The world z the horizon backdrop lies at on the relief: the frame's
   * lowest terrain over the datum, in world units at the frame's rise, never
   * over the plane. Zero off the relief.
   */
  static backdropFloorLift(relief: GroundReliefFrame | undefined): number {
    if (relief === undefined || !relief.isActive) return 0;
    const range = relief.heightRangeMetres;
    if (range === undefined) return 0;
    const metres = Math.min(range.lowerBound - relief.datumMetres, 0);
    return metres * relief.worldUnitsPerMetre * relief.strength;
  }

  /** Lets go of every texture, the atlas and the grids. */
  destroy(): void {
    this.sources = [];
    this.pendingBakes = [];
    this.textures.clear();
    this.dropAtlas();
    this.grid.destroy();
  }

  /**
   * The fill runs of a tile's ground, in buffer order (bottom to top),
   * adjacent runs in one draw. The ribbons are left out: the lines are
   * never in a raster tile. A run faded out at the planning zoom is left
   * out, as the vector ground leaves it out, and the rest take their fade's
   * alpha in the shader.
   */
  private encodeFills(pass: GPURenderPassEncoder, resident: FlatResidentTile, planningZoom: number): void {
    const ground = resident.gpu.ground;
    if (!ground.styles) return;
    const spans = visibleRunSpans(ground, planningZoom, isFillRun);
    if (spans.length === 0) return;
    pass.setBindGroup(1, ground.styles);
    pass.setVertexBuffer(0, resident.gpu.buffer, ground.vertexOffset, ground.vertexCount * 16);
    pass.setIndexBuffer(resident.gpu.buffer, ground.indexFormat, ground.indexOffset, ground.indexCount * (ground.indexFormat === "uint16" ? 2 : 4));
    for (const [start, count] of spans) if (count > 0) pass.drawIndexed(count, 1, start, 0, 0);
  }

  /** The atlas, at least `width` by `height`, grown when a frame needs more. */
  private ensureAtlas(width: number, height: number): BakeAtlas {
    const current = this.atlas ? { width: this.atlas.resolved.width, height: this.atlas.resolved.height } : undefined;
    const grown = grownRasterAtlasSize(current, width, height);
    if (grown === undefined && this.atlas) return this.atlas;
    const side = grown ?? { width, height };
    this.dropAtlas();
    const samples = this.device.createTexture({
      label: "raster tile atlas samples",
      size: [side.width, side.height],
      format: RASTER_TILE_TEXTURE_FORMAT,
      sampleCount: RASTER_TILE_BAKE_SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const resolved = this.device.createTexture({
      label: "raster tile atlas",
      size: [side.width, side.height],
      format: RASTER_TILE_TEXTURE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.atlas = { samples, resolved, samplesView: samples.createView(), resolvedView: resolved.createView() };
    return this.atlas;
  }

  private dropAtlas(): void {
    this.atlas?.samples.destroy();
    this.atlas?.resolved.destroy();
    this.atlas = undefined;
  }
}
