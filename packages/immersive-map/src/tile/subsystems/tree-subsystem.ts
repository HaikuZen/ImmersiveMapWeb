// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The trees of the flat map's woods and parks, a port of the Swift
 * `TreeRenderSubsystem` and `TreeDrawer`: the engine's tree model
 * (`TreeModelStore`), instanced over each tile's trees (the arena's tree
 * instances, placed by the parser), opaque into the world pass with the
 * buildings. The trees draw from the tiles the buildings draw from
 * (`TreeCoveragePlanner` follows `BuildingCoveragePlanner`), from the camera
 * zoom the settings name (`TreeSettings.minimumZoom`), and rise out of the
 * ground with the buildings (`ExtrusionRise`). Below
 * `TreeSettings.fullDensityZoom` a tile draws a prefix of each quarter's
 * trees, which are sorted by priority, so the trees thin evenly and a far
 * zoom's trees are among a near zoom's.
 *
 * Their shadows are not the shadow map's: each tree lays a soft disc on the
 * ground under its crown, drawn in the roads' layer after the roads so it
 * lies over them, with the shadow map's darkening and tint, and not at all
 * while the shadow gate is closed. Registered after the ground's subsystem
 * for that.
 *
 * A draw's tile rides in a dynamic uniform offset (`TREE_TILE_SLOT_BYTES` a
 * slot), so its instance index is its tree's: the instances are an
 * instance-stepped vertex buffer at the tile's tree span.
 */

import type { SceneLightSettings, TreeSettings } from "../../configuration/scene-settings.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { RenderLayer } from "../../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../../render/frame-engine.ts";
import type { ImmersiveMapTreePalette } from "../../style/theme.ts";
import { ExtrusionRise } from "../../utils/extrusion-rise.ts";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import type { FlatResidentTile } from "../drawers/flat-map-surface-drawer.ts";
import { TreeCrown, treeInstanceRanges } from "../drawers/tree-instance-ranges.ts";
import { type PlaceTile, visibleTileKey, type VisibleTile } from "../placement/place-tile.ts";
import { type StandingPipelines, TREE_INSTANCE_STRIDE, TREE_TILE_SLOT_BYTES, TreeFrameUniformLayout, writeTreeFrameUniform } from "../pipelines/standing-pipelines.ts";
import { standingGeometry, type TreeInstances } from "../store/standing-geometry.ts";
import type { TreeModelStore } from "../trees/tree-model-store.ts";
import { visibleQuarters } from "../visibility/quarter-frustum.ts";
import { squaresOverlap, standingCeiling, type StandingFrame, type StandingFrameState } from "./standing-frame.ts";

interface TreeItem {
  readonly placement: PlaceTile<FlatResidentTile>;
  readonly trees: TreeInstances;
  /** Half-open runs of the tile's trees this frame. */
  readonly ranges: [number, number][];
  readonly riseScale: number;
}

const SLOT_FLOATS = TREE_TILE_SLOT_BYTES / 4;

export class TreeSubsystem implements RenderSubsystem {
  readonly name = "Trees";
  readonly layers: readonly RenderLayer[] = ["buildingExtrusion", "flatMapRoads"];
  private readonly rise = new ExtrusionRise<VisibleTile>(visibleTileKey);
  private items: TreeItem[] = [];
  private level = 0;
  private tileStaging = new Float32Array(SLOT_FLOATS * 16);
  private tileBuffer: GPUBuffer;
  private tileGroup: GPUBindGroup;
  private readonly frameStaging = new Float32Array(TreeFrameUniformLayout.byteLength / 4);

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: StandingPipelines,
    private readonly frame: StandingFrame,
    private readonly modelStore: TreeModelStore,
    private readonly settings: TreeSettings,
    private readonly riseSeconds: number,
    private readonly light: () => SceneLightSettings,
    private readonly palette: () => ImmersiveMapTreePalette,
    private readonly state: () => StandingFrameState,
  ) {
    [this.tileBuffer, this.tileGroup] = this.makeTileBuffer(16);
  }

  /** Whether a tile's trees are still rising and the frames have to keep coming. */
  get isRising(): boolean {
    return this.rise.isAnimating;
  }

  update(context: FrameContext): void {
    const { placements, renderSurfaceMode, timeSeconds } = this.state();
    const zoom = context.planningZoom;
    const isRaised = this.settings.isEnabled && renderSurfaceMode === "flat" && zoom >= this.settings.minimumZoom && this.modelStore.mesh !== undefined;
    const drawn = isRaised ? placements.filter((p) => standingGeometry(p.resident.gpu).trees !== undefined) : [];
    this.rise.advance(
      drawn.map((p) => p.placeIn),
      timeSeconds,
      this.riseSeconds,
      squaresOverlap,
    );
    // All of a tile's trees from the full-density zoom, halving with every zoom below it.
    const share = Math.min(1, 2 ** (zoom - this.settings.fullDensityZoom));
    this.level = zoom >= this.settings.nearDetailZoom ? 0 : 1;
    this.items = [];
    const { flatRenderState, projectionView } = this.state();
    const ceiling = standingCeiling(flatRenderState.renderMapSize);
    for (const placement of drawn) {
      const scale = this.rise.heightScale(placement.placeIn, timeSeconds);
      if (scale <= 0) continue;
      const trees = standingGeometry(placement.resident.gpu).trees!;
      // Only the quarters in the camera's view (`visibleQuarters`, not in Swift).
      const tile = placement.resident.tile;
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, placement.placeIn.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
      const quarters = visibleQuarters(projectionView, ox, oy, size, ceiling, placement.quarters, trees.quarterStarts.length === 5);
      if (quarters === 0) continue;
      const ranges = treeInstanceRanges(trees.count, trees.quarterStarts, quarters, share);
      if (ranges.length > 0) this.items.push({ placement, trees, ranges, riseScale: scale });
    }
  }

  /** The tiles' uniforms and the trees' frame, once a frame. */
  prepareGPU(): void {
    const mesh = this.modelStore.mesh;
    if (this.items.length === 0 || !mesh) return;
    const { flatRenderState } = this.state();
    if (this.items.length * SLOT_FLOATS > this.tileStaging.length) {
      const slots = 2 ** Math.ceil(Math.log2(this.items.length));
      this.tileBuffer.destroy();
      [this.tileBuffer, this.tileGroup] = this.makeTileBuffer(slots);
      this.tileStaging = new Float32Array(slots * SLOT_FLOATS);
    }
    const f = this.tileStaging;
    this.items.forEach((item, slot) => {
      const tile = item.placement.resident.tile;
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, item.placement.placeIn.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
      const scale = size / 4096;
      const base = slot * SLOT_FLOATS;
      f.fill(0, base, base + 20);
      f[base] = scale;
      f[base + 5] = scale;
      f[base + 10] = scale;
      f[base + 12] = ox;
      f[base + 13] = oy;
      f[base + 15] = 1;
      f[base + 16] = item.riseScale / mesh.contents.heightMetres;
    });
    this.device.queue.writeBuffer(this.tileBuffer, 0, f, 0, this.items.length * SLOT_FLOATS);
    const contents = mesh.contents;
    writeTreeFrameUniform(this.frameStaging, this.light().direction, this.palette(), contents.radiusMetres * TreeCrown.radiusShare, contents.heightMetres * TreeCrown.centreHeightShare);
    this.device.queue.writeBuffer(this.frame.treeFrameBuffer, 0, this.frameStaging);
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    const mesh = this.modelStore.mesh;
    if (this.state().renderSurfaceMode !== "flat" || this.items.length === 0 || !mesh) return;
    if (layer === "buildingExtrusion") {
      const levels = mesh.contents.levels;
      const level = levels[Math.min(Math.max(this.level, 0), levels.length - 1)]!;
      pass.setPipeline(this.pipelines.tree);
      pass.setBindGroup(0, this.frame.bindGroup());
      pass.setVertexBuffer(0, mesh.buffer, level.vertexOffset, level.vertexCount * 20);
      pass.setIndexBuffer(mesh.buffer, "uint16", level.indexOffset, level.indexCount * 2);
      this.items.forEach((item, slot) => {
        pass.setBindGroup(1, this.tileGroup, [slot * TREE_TILE_SLOT_BYTES]);
        pass.setVertexBuffer(1, item.placement.resident.gpu.buffer, item.trees.byteOffset, item.trees.count * TREE_INSTANCE_STRIDE);
        pass.setStencilReference(TileSourceStencilPriority.reference(item.placement.resident.tile.z) | TileSourceStencilPriority.surfaceMaskBit);
        for (const [start, end] of item.ranges) pass.drawIndexed(level.indexCount, end - start, 0, 0, start);
      });
      return;
    }
    // The discs lie on the ground and fade into the fog as it does, past the shadow gate only.
    if (layer !== "flatMapRoads" || !this.frame.shadows.frameState || this.frame.shadows.frameState.shadowUniform.strength <= 0) return;
    pass.setPipeline(this.pipelines.treeShadow);
    pass.setBindGroup(0, this.frame.bindGroup());
    this.items.forEach((item, slot) => {
      pass.setBindGroup(1, this.tileGroup, [slot * TREE_TILE_SLOT_BYTES]);
      pass.setVertexBuffer(0, item.placement.resident.gpu.buffer, item.trees.byteOffset, item.trees.count * TREE_INSTANCE_STRIDE);
      for (const [start, end] of item.ranges) pass.draw(6, end - start, 0, start);
    });
  }

  destroy(): void {
    this.tileBuffer.destroy();
  }

  private makeTileBuffer(slots: number): [GPUBuffer, GPUBindGroup] {
    const buffer = this.device.createBuffer({ label: "tree tiles", size: slots * TREE_TILE_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = this.device.createBindGroup({
      label: "tree tiles",
      layout: this.pipelines.treeTileLayout,
      entries: [{ binding: 0, resource: { buffer, size: 80 } }],
    });
    return [buffer, group];
  }
}
