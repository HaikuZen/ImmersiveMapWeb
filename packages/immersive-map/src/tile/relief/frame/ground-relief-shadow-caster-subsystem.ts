// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { groundFlatteningGrid, type GroundFlatteningSettings } from "../../../configuration/tile-settings.ts";
import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import { type Mat4, mat4Multiply } from "../../../math/matrix.ts";
import type { RenderLayer } from "../../../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../../../render/frame-engine.ts";
import { ShadowCascadeAtlas } from "../../../shadows/shadow-cascade-atlas.ts";
import { ShadowFrameState } from "../../../shadows/shadow-frame-state.ts";
import { PlacementGroundSquare } from "../../placement/placement-ground-squares.ts";
import { gridVertexLayout } from "../../pipelines/placement-pipeline.ts";
import { RasterTileGrid, RasterTileGridMeshes } from "../../raster/raster-tile-grid.ts";
import type { TileFrameState } from "../../subsystems/flat-tile-subsystems.ts";
import { tileKey } from "../../tile.ts";
import type { GroundRelief } from "../lifts/ground-relief.ts";
import relief from "../shaders/ground-relief.wgsl?raw";
import reliefShadow from "../shaders/ground-relief-shadow.wgsl?raw";
import type { GroundReliefGpu } from "./ground-relief-gpu.ts";

/**
 * The mountains' shadows, a port of the Swift
 * `GroundReliefShadowCasterSubsystem`: the ground relief drawn into the
 * shadow map (`shadowCasters` and `farShadowCasters`, one pass a window), as
 * the buildings are, so a ridge darkens the valley behind it from the
 * scene's sun, and everything that reads the shadow map on the relief takes
 * the shadow (the ground's relief variants, the buildings).
 *
 * Every point of the ground casts once, from the surface the frame shows
 * there: each placement casts from its square less the finer squares inside
 * it (`PlacementGroundSquare.squares`). The heights are the ones the ground
 * draws with, the source's relief narrowed to the square drawn. The square
 * is the raster tiles' grid raised by those heights, from the light, depth
 * only, with the receiving ground's cells: a raster source's raster grid, a
 * vector source's flattening grid up to `maximumVectorCells`, the depth bias
 * by the slope covering the rest.
 *
 * It draws when the mountains cast this frame (`GroundReliefFrame.castsShadows`),
 * which opens the shadow pass with no building in sight
 * (`ShadowPassGateResolver`), and the pass runs only when the map went stale
 * (`ShadowMapReuseController`, the terrain's signature among what makes it so).
 */
export class GroundReliefShadowCasterSubsystem implements RenderSubsystem {
  readonly name = "GroundReliefShadowCasters";
  readonly layers: readonly RenderLayer[] = ["shadowCasters", "farShadowCasters"];

  /** The most cells a side a vector placement's caster takes: shadows of the same shape at a quarter of the near ring's triangles. */
  static readonly maximumVectorCells = 128;
  /** The depth bias by the slope, in the light's depth: the caster's grid and the receiving ground meet with a sliver of difference. */
  static readonly slopeDepthBias = 4;

  private readonly pipeline: GPURenderPipeline;
  private readonly grid: RasterTileGridMeshes;
  private readonly emptyGroup: GPUBindGroup;
  private readonly lightModel: Mat4 = new Float64Array(16);
  private readonly model: Mat4 = new Float64Array(16);

  constructor(
    device: GPUDevice,
    private readonly drawLayout: GPUBindGroupLayout,
    private readonly reliefGpu: GroundReliefGpu,
    private readonly groundFlattening: GroundFlatteningSettings,
    private readonly state: () => TileFrameState,
    private readonly shadows: () => ShadowFrameState | undefined,
  ) {
    this.grid = new RasterTileGridMeshes(device);
    const emptyLayout = device.createBindGroupLayout({ label: "relief caster empty", entries: [] });
    this.emptyGroup = device.createBindGroup({ label: "relief caster empty", layout: emptyLayout, entries: [] });
    const module = device.createShaderModule({ label: "relief shadow casters", code: [relief, reliefShadow].join("\n") });
    this.pipeline = device.createRenderPipeline({
      label: "relief shadow casters",
      layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, drawLayout, emptyLayout, reliefGpu.layout] }),
      vertex: { module, entryPoint: "groundReliefShadowVertex", buffers: [gridVertexLayout] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: ShadowCascadeAtlas.depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less-equal",
        depthBias: 0,
        depthBiasSlopeScale: GroundReliefShadowCasterSubsystem.slopeDepthBias,
      },
    });
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const slot = ShadowCascadeAtlas.slotOfCasterLayer(layer);
    const { placements, renderSurfaceMode, relief, flatRenderState } = this.state();
    if (slot === undefined || renderSurfaceMode !== "flat" || relief === undefined || !relief.castsShadows) return;
    const shadows = this.shadows();
    const lightProjectionView = shadows === undefined ? undefined : ShadowFrameState.lightProjectionView(shadows, slot);
    if (lightProjectionView === undefined) return;
    // A pass adding the buildings that arrived or rose over its kept slice
    // has the mountains in it already. A pass drawing a cleared region
    // again draws them too, held to the region by its scissor.
    const casterPass = ShadowFrameState.casterPass(shadows!, slot);
    if (casterPass?.added !== undefined && casterPass.region === undefined) return;
    // The horizon backdrop is no ground of the planner's and casts nothing.
    const casters = PlacementGroundSquare.squares(placements.filter((p) => !p.isHorizonBackdrop));
    if (casters.length === 0) return;
    const rasterSizes = RasterTileGrid.rasterSizesBySource(placements);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.emptyGroup);
    pass.setBindGroup(2, this.emptyGroup);
    let boundDraws: GPUBindGroup | undefined;
    // A source split into several squares looks its relief up once.
    const sourceReliefs = new Map<string, { relief: GroundRelief; cells: number } | undefined>();
    for (const caster of casters) {
      const source = caster.source;
      const key = `${tileKey(source.tile)}@${source.worldWrap}>${source.displacement === undefined ? "-" : tileKey(source.displacement)}`;
      let resolved = sourceReliefs.get(key);
      if (resolved === undefined && !sourceReliefs.has(key)) {
        const ground = source.displacement === undefined ? undefined : relief.relief(source.tile, source.displacement);
        if (ground !== undefined) {
          const gridCells = groundFlatteningGrid(this.groundFlattening, source.tile.z);
          const rasterSize = rasterSizes.get(tileKey(source.tile));
          const cells = rasterSize === undefined ? Math.min(gridCells, GroundReliefShadowCasterSubsystem.maximumVectorCells) : RasterTileGrid.reliefCells(gridCells, ground, rasterSize);
          resolved = { relief: ground, cells };
        }
        sourceReliefs.set(key, resolved);
      }
      if (resolved === undefined) continue;
      const square = caster.square.tile;
      // The source's cells over the part of it drawn, on the same lines.
      const mesh = this.grid.mesh(PlacementGroundSquare.cells(resolved.cells, source.tile.z, square.z));
      this.reliefGpu.bind(pass, 3, resolved.relief.narrowed(square, source.tile), undefined, square, relief, flatRenderState.renderMapSize);
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(square.x, square.y, square.z, caster.square.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
      const scale = size / 4096;
      const m = this.model;
      m.fill(0);
      m[0] = scale;
      m[5] = scale;
      m[10] = 1;
      m[12] = ox;
      m[13] = oy;
      m[15] = 1;
      mat4Multiply(this.lightModel, lightProjectionView, m);
      const record = context.drawParameters.allocate();
      const f = context.drawParameters.f32;
      for (let i = 0; i < 16; i++) f[record.index + i] = this.lightModel[i]!;
      // The light's z column: a lift in world units moves the clip position by it.
      for (let i = 0; i < 4; i++) f[record.index + 16 + i] = lightProjectionView[8 + i]!;
      const draws = context.drawParameters.bindGroup(this.drawLayout);
      if (draws !== boundDraws) pass.setBindGroup(1, (boundDraws = draws));
      pass.setVertexBuffer(0, mesh.vertices);
      pass.setIndexBuffer(mesh.indices, mesh.indexFormat);
      pass.drawIndexed(mesh.indexCount, 1, 0, 0, record.instance);
    }
  }

  destroy(): void {
    this.grid.destroy();
  }
}
