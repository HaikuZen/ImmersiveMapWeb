// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The tile subsystems of the frame: the placement prepass on either surface
 * (the Swift `PlacementStencilRenderSubsystem`) and the flat map's ground
 * with what lies on it (the Swift `FlatMapSurfaceRenderSubsystem`). Both
 * read the frame's placements from the working set through `state()`.
 */

import type { ViewMode } from "../../camera/view-mode.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { GlobeSphereVertexPath, GlobeSurfaceTile } from "../../globe/globe-frame-constants.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { RenderLayer } from "../../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../../render/frame-engine.ts";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import { type FlatResidentTile, FlatMapSurfaceDrawer } from "../drawers/flat-map-surface-drawer.ts";
import type { PlaceTile } from "../placement/place-tile.ts";
import type { PlacementPipeline } from "../pipelines/placement-pipeline.ts";
import type { FlatTilePipelines } from "../pipelines/tile-pipeline.ts";
import { RasterTileGrid, RasterTileGridMeshes, type RasterTileGridMesh } from "../raster/raster-tile-grid.ts";
import { groundFlatteningGrid, type GroundFlatteningSettings } from "../../configuration/tile-settings.ts";
import { PlacementGroundSquare } from "../placement/placement-ground-squares.ts";
import { type Tile, tileKey } from "../tile.ts";
import { visibleTileKey } from "../placement/place-tile.ts";
import type { GroundReliefFrame } from "../relief/frame/ground-relief-frame.ts";
import type { GroundReliefGpu } from "../relief/frame/ground-relief-gpu.ts";
import type { GroundRelief } from "../relief/lifts/ground-relief.ts";

/** What the tile subsystems read of a frame: its placements and the surface they lie on. */
export interface TileFrameState {
  placements: readonly PlaceTile<FlatResidentTile>[];
  renderSurfaceMode: ViewMode;
  flatRenderState: FlatRenderState;
  /** The globe the sphere's draws project by: its geometry transition is the morph's. */
  globe: GlobeUniform;
  /** The frame's ground relief, `undefined` on a map without one (`GroundReliefFrame.isActive` says whether the frame is on it). */
  relief?: GroundReliefFrame | undefined;
}

/** A source's ground as the ground draws it: its relief out of the terrain its placements are bound to, and its grid's cells a side. */
interface SourceGround {
  readonly relief: GroundRelief | undefined;
  readonly cells: number;
}

/**
 * Coarse squares first, so a finer placement's mark lies over a coarser
 * one's.
 *
 * On the relief the squares overlap on the screen as well as on the ground:
 * a near mountain stands in front of the ground of the squares behind it,
 * and the mark of a pixel has to be the placement whose ground is seen
 * there. So the relief takes two passes. The first draws the ground's depth:
 * every point of the ground once, from the placement the planner gave it
 * (`PlacementGroundSquare.squares`), each square on its source's own grid
 * lines, as its ground is drawn. Then the marks, every placement's whole
 * square, coarse first, tested against that depth: a square's mark lands
 * only where its ground is the one in front. That depth serves the marks
 * alone: once they are written it is put back to the cleared far plane, so
 * the ground passes meet the depth they always met, their own.
 */
export class PlacementStencilSubsystem implements RenderSubsystem {
  readonly name = "PlacementStencil";
  readonly layers: readonly RenderLayer[] = ["placementStencil"];
  private readonly grid: RasterTileGridMeshes;

  constructor(
    device: GPUDevice,
    private readonly pipeline: PlacementPipeline,
    private readonly state: () => TileFrameState,
    private readonly reliefGpu: GroundReliefGpu,
    private readonly groundFlattening: GroundFlatteningSettings,
  ) {
    this.grid = new RasterTileGridMeshes(device);
  }

  encode(_layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const { placements, renderSurfaceMode, relief } = this.state();
    if (placements.length === 0) return;
    const ordered = [...placements].sort((a, b) => a.placeIn.tile.z - b.placeIn.tile.z);
    pass.setBindGroup(0, context.frameBindGroup);
    if (renderSurfaceMode !== "flat") {
      this.encodeSphere(ordered, pass, context);
    } else if (relief === undefined || !relief.isActive) {
      this.encodeFlat(ordered, pass, context);
    } else {
      this.encodeRelief(ordered, pass, context, relief);
    }
  }

  /**
   * The relief: the horizon backdrop first, flat and with no depth (its mark
   * is under every other's and it takes no part in the ground's depth), then
   * the ground's depth, the marks tested against it, and the depth back to
   * the far plane.
   */
  private encodeRelief(placements: readonly PlaceTile<FlatResidentTile>[], pass: GPURenderPassEncoder, context: FrameContext, relief: GroundReliefFrame): void {
    const backdrops = placements.filter((p) => p.isHorizonBackdrop);
    const ground = placements.filter((p) => !p.isHorizonBackdrop);
    if (backdrops.length > 0) this.encodeFlat(backdrops, pass, context);
    const rasterSizes = RasterTileGrid.rasterSizesBySource(ground);
    const grounds = new Map<string, SourceGround>();
    const sourceGround = (tile: Tile, worldWrap: number, displacement: Tile | undefined): SourceGround => {
      const key = `${visibleTileKey({ tile, worldWrap })}>${displacement === undefined ? "-" : tileKey(displacement)}`;
      let known = grounds.get(key);
      if (known === undefined) {
        known = this.sourceGround(tile, displacement, rasterSizes, relief);
        grounds.set(key, known);
      }
      return known;
    };
    const { flatRenderState } = this.state();
    this.reliefGpu.bindEmpty(pass, 3);
    pass.setBindGroup(2, this.pipeline.emptyGroup);
    let selected: GPURenderPipeline | undefined;
    const select = (pipeline: GPURenderPipeline) => {
      if (selected !== pipeline) pass.setPipeline((selected = pipeline));
    };
    let boundMesh: RasterTileGridMesh | undefined;
    let boundDraws: GPUBindGroup | undefined;
    const draw = (square: { tile: Tile; worldWrap: number }, source: Tile, groundOfSource: SourceGround, reliefPipeline: GPURenderPipeline, flatPipeline: GPURenderPipeline) => {
      const squareCells = PlacementGroundSquare.cells(groundOfSource.cells, source.z, square.tile.z);
      const mesh = groundOfSource.relief !== undefined ? this.grid.mesh(squareCells) : this.grid.forTileZoom(square.tile.z);
      if (groundOfSource.relief !== undefined) {
        select(reliefPipeline);
        this.reliefGpu.bind(pass, 3, groundOfSource.relief.narrowed(square.tile, source), undefined, square.tile, relief, flatRenderState.renderMapSize);
      } else {
        select(flatPipeline);
      }
      if (mesh !== boundMesh) {
        boundMesh = mesh;
        pass.setVertexBuffer(0, mesh.vertices);
        pass.setIndexBuffer(mesh.indices, mesh.indexFormat);
      }
      const record = this.writeModel(context, square.tile, square.worldWrap);
      const group = context.drawParameters.bindGroup(this.pipeline.drawLayout);
      if (group !== boundDraws) pass.setBindGroup(1, (boundDraws = group));
      pass.drawIndexed(mesh.indexCount, 1, 0, 0, record);
    };
    // The ground's depth: every point of the ground once, behind its surface
    // by a bias, so its own mark, the same grid again, passes against it.
    for (const square of PlacementGroundSquare.squares(ground)) {
      const source = square.source;
      draw(square.square, source.tile, sourceGround(source.tile, source.worldWrap, source.displacement), this.pipeline.reliefGroundDepth, this.pipeline.flatGroundDepth);
    }
    // The marks, coarse first, tested against that depth. A source's relief
    // is one terrain wherever it draws, so a mark meets the depth the first
    // pass drew from the same heights.
    const displacements = PlacementGroundSquare.displacements(ground);
    for (const placement of ground) {
      const source = placement.resident.tile;
      const wrap = placement.placeIn.worldWrap;
      const displacement = displacements.get(visibleTileKey({ tile: source, worldWrap: wrap })) ?? placement.displacement;
      pass.setStencilReference(TileSourceStencilPriority.reference(source.z));
      draw(placement.placeIn, source, sourceGround(source, wrap, displacement), this.pipeline.reliefMarks, this.pipeline.flatMarksTested);
    }
    // The depth back to the far plane: it was the marks' to test against.
    pass.setPipeline(this.pipeline.depthReset);
    pass.draw(3);
  }

  /**
   * A source's ground as the ground draws it: its relief out of the terrain
   * its placements are bound to, and its grid's cells a side, a raster
   * source's the raster ground's (`RasterTileGrid.reliefCells`), a vector
   * source's the flattening's.
   */
  private sourceGround(tile: Tile, displacement: Tile | undefined, rasterSizes: ReadonlyMap<string, number>, frame: GroundReliefFrame): SourceGround {
    const gridCells = groundFlatteningGrid(this.groundFlattening, tile.z);
    const relief = displacement === undefined ? undefined : frame.relief(tile, displacement);
    if (relief === undefined) return { relief: undefined, cells: 0 };
    const rasterSize = rasterSizes.get(tileKey(tile));
    return { relief, cells: rasterSize === undefined ? gridCells : RasterTileGrid.reliefCells(gridCells, relief, rasterSize) };
  }

  /** A draw record with the square's model matrix: its instance. */
  private writeModel(context: FrameContext, tile: Tile, worldWrap: number): number {
    const { flatRenderState } = this.state();
    const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
    const scale = size / 4096;
    const record = context.drawParameters.allocate();
    const f = context.drawParameters.f32;
    const i = record.index;
    f[i] = scale;
    f[i + 5] = scale;
    f[i + 10] = 1;
    f[i + 12] = ox;
    f[i + 13] = oy;
    f[i + 15] = 1;
    return record.instance;
  }

  /** Lets go of the grids. */
  destroy(): void {
    this.grid.destroy();
  }

  private encodeFlat(placements: readonly PlaceTile<FlatResidentTile>[], pass: GPURenderPassEncoder, context: FrameContext): void {
    const { flatRenderState } = this.state();
    pass.setPipeline(this.pipeline.pipeline);
    let bound: GPUBindGroup | undefined;
    for (const p of placements) {
      const t = p.placeIn.tile;
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(t.x, t.y, t.z, p.placeIn.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
      const scale = size / 4096;
      const record = context.drawParameters.allocate();
      const f = context.drawParameters.f32;
      const i = record.index;
      f[i] = scale;
      f[i + 5] = scale;
      f[i + 10] = 1;
      f[i + 12] = ox;
      f[i + 13] = oy;
      f[i + 15] = 1;
      const group = context.drawParameters.bindGroup(this.pipeline.drawLayout);
      if (group !== bound) pass.setBindGroup(1, (bound = group));
      pass.setStencilReference(TileSourceStencilPriority.reference(p.resident.tile.z));
      pass.draw(6, 1, 0, record.instance);
    }
  }

  /**
   * The sphere has one copy of the world: a placement's square is its
   * tile's place on the sphere, the raster tile's grid as the raster tile
   * draws it.
   */
  private encodeSphere(placements: readonly PlaceTile<FlatResidentTile>[], pass: GPURenderPassEncoder, context: FrameContext): void {
    const { renderSurfaceMode, globe } = this.state();
    pass.setPipeline(this.pipeline.sphere(!GlobeSphereVertexPath.isPureSphere(renderSurfaceMode, globe.transition)));
    let bound: GPUBindGroup | undefined;
    let boundMesh: RasterTileGridMesh | undefined;
    for (const p of placements) {
      const tile = p.placeIn.tile;
      const mesh = this.grid.forTileZoom(tile.z);
      if (mesh !== boundMesh) {
        boundMesh = mesh;
        pass.setVertexBuffer(0, mesh.vertices);
        pass.setIndexBuffer(mesh.indices, mesh.indexFormat);
      }
      const record = context.drawParameters.allocate();
      GlobeSurfaceTile.write(context.drawParameters.f32, record.index, tile);
      const group = context.drawParameters.bindGroup(this.pipeline.drawLayout);
      if (group !== bound) pass.setBindGroup(1, (bound = group));
      pass.setStencilReference(TileSourceStencilPriority.reference(p.resident.tile.z));
      pass.drawIndexed(mesh.indexCount, 1, 0, 0, record.instance);
    }
  }
}

export class FlatMapSurfaceSubsystem implements RenderSubsystem {
  readonly name = "FlatMapSurface";
  readonly layers: readonly RenderLayer[] = ["flatMapSurface", "flatMapRoads"];
  private readonly drawer: FlatMapSurfaceDrawer;
  /** The frame's sources and their reliefs, worked out once for both layers. */
  private frameSources: { placements: readonly PlaceTile<FlatResidentTile>[]; relief: GroundReliefFrame | undefined; sources: ReturnType<FlatMapSurfaceDrawer["sources"]> } | undefined;

  constructor(
    pipelines: FlatTilePipelines,
    private readonly state: () => TileFrameState,
    private readonly reliefGpu: GroundReliefGpu,
  ) {
    this.drawer = new FlatMapSurfaceDrawer(pipelines);
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const { placements, flatRenderState, renderSurfaceMode, relief } = this.state();
    if (placements.length === 0 || renderSurfaceMode !== "flat") return;
    const reliefFrame = relief?.isActive === true ? relief : undefined;
    let cached = this.frameSources;
    if (cached === undefined || cached.placements !== placements || cached.relief !== reliefFrame) {
      const sources = this.drawer.sources(placements);
      FlatMapSurfaceDrawer.resolveReliefs(sources, reliefFrame);
      cached = { placements, relief: reliefFrame, sources };
      this.frameSources = cached;
    }
    const sources = cached.sources;
    this.drawer.draw(
      pass,
      {
        frameBindGroup: context.frameBindGroup,
        drawParameters: context.drawParameters,
        cameraZoom: context.planningZoom,
        pixelsPerPoint: context.pixelsPerPoint,
        drawHeightPx: context.drawHeight,
        flatRenderState,
        reliefGpu: this.reliefGpu,
        reliefFrame,
      },
      sources,
      layer === "flatMapSurface" ? "ground" : "roads",
    );
  }
}
