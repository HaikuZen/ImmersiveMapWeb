// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Draws the models of the model archive (`ImmersiveMapSettings.modelArchive`),
 * a port of the Swift `ModelTileRenderSubsystem` and `ModelTileDrawer`: each
 * frame it names the model tiles in and around the view
 * (`wantedModelTiles`), takes the ones the store has on the GPU, and draws
 * each in the scene models' layer and in the shadow casters'. A tile's
 * models are one mesh in the tile's space, so a tile is one draw under the
 * matrix the map's own buildings of that tile take, and the models lie on
 * the flat map as the buildings do. Like the buildings, they draw on the
 * flat map only.
 *
 * A tile draws as soon as it is loaded, from the models' zoom on
 * (`ModelArchiveSettings.minimumZoom`), coming up out of the ground whole
 * (`ExtrusionRise`). A loaded tile names the map buildings its models stand
 * in for (`SceneModelFrameState.replacedBuildings`), and the buildings'
 * subsystem leaves those out of the same frame. A tile not yet loaded names
 * nothing, and the buildings under it wait for it
 * (`SceneModelFrameState.pendingModelTiles`).
 *
 * Updates after the scene models' subsystem, which starts the frame's
 * model state over, and before the buildings'. Each drawn tile casts into
 * the shadow map as a static caster, one key a tile and world copy in the
 * map's caster set: the shadow map renders again when the set changes. Not
 * in Swift, both for the GPU budget (a tile of the Kremlin is over a
 * million triangles): a tile casts once it has risen, not while it rises,
 * and the far window leaves out the tiles inside its caster hole, as it
 * leaves out the buildings' quarters there (`ShadowCasterPassPlan.hole`).
 *
 * Also not in Swift, for the same budget: the world pass draws only the
 * models of a tile in view whose outline holds a sample
 * (`visibleModelRuns`), and of a standing tile only the triangles that
 * draw a sample, culled on the GPU each frame the camera moves
 * (`ModelTileTriangleCuller`). Neither changes a pixel. The shadow casters
 * draw their tiles whole.
 */

import { Frustum } from "../../camera/frustum.ts";
import { type Mat4, mat4Multiply } from "../../math/matrix.ts";
import type { RenderLayer } from "../../render/core/render-layer.ts";
import type { SceneModelFrameState } from "../../render/core/scene-model-frame-state.ts";
import type { FrameContext, RenderSubsystem } from "../../render/frame-engine.ts";
import { ShadowCascadeAtlas, type ShadowCascadeSlot } from "../../shadows/shadow-cascade-atlas.ts";
import { ShadowFrameState } from "../../shadows/shadow-frame-state.ts";
import { type ShadowCasterKeyPlacement, ShadowMapReuseController } from "../../shadows/shadow-map-reuse-controller.ts";
import { TileSourceStencilPriority } from "../../tile/drawers/depth-rank.ts";
import { type VisibleTile, visibleTileKey } from "../../tile/placement/place-tile.ts";
import type { StandingFrame } from "../../tile/subsystems/standing-frame.ts";
import { quartersAll } from "../../tile/tile-quarters.ts";
import { tileKey } from "../../tile/tile.ts";
import { ExtrusionRise } from "../../utils/extrusion-rise.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { ViewMode } from "../../camera/view-mode.ts";
import type { ModelPipelines } from "../pipelines/model-pipelines.ts";
import type { ModelTileMesh, ModelTileUploader } from "./model-tile-mesh.ts";
import { modelTilePlacement, wantedModelTiles } from "./model-tile-placement.ts";
import type { ModelTileStore } from "./model-tile-store.ts";
import { runTriangleCount, type SampleGrid, sampleGrid, visibleModelRuns } from "./model-tile-culling.ts";
import type { ModelTileTriangleCuller, TriangleCullJob } from "./model-tile-triangle-culler.ts";

/** What the model tiles read of the frame being drawn. */
export interface ModelTileFrameInput {
  readonly renderSurfaceMode: ViewMode;
  readonly planningZoom: number;
  /** The coverage's map tiles, finest first (`VisibleContentState.visibleTiles`). */
  readonly visibleTiles: readonly VisibleTile[];
  readonly flatRenderState: FlatRenderState;
  readonly projectionView: Mat4;
  readonly timeSeconds: number;
  /** The light's windows before the shadow gate (`ShadowFrameRuntime.resolvedFrameState`): what the casters are culled by. */
  readonly shadowFrameState: ShadowFrameState | undefined;
}

/** How the models draw, read each frame so a change of the bias applies live. */
export interface ModelTileDrawSettings {
  /** `ModelArchiveSettings.minimumZoom`. */
  readonly minimumZoom: number;
  /** `ExtrusionSettings.riseSeconds`. */
  readonly riseSeconds: number;
  /** `modelDepthBias` at a camera zoom. */
  depthBias(zoom: number): number;
}

interface DrawItem {
  readonly mesh: ModelTileMesh;
  /** The stored positions into the flat world, lowered while the tile comes up out of the ground. */
  readonly model: Mat4;
  /** Whether the tile is still partly under the ground, coming up: what is below the ground is not drawn. */
  readonly isRising: boolean;
  readonly caster: ShadowCasterKeyPlacement;
  /** The tile's bounds on the flat world's plane: x, y of the minimum, x, y of the maximum. */
  readonly footprint: readonly [number, number, number, number];
  /** The world pass's triangles: runs of first triangle and count, the models in view and large enough (`visibleModelRuns`). */
  runs: readonly number[];
  /** Whether the world pass draws the tile's culled index buffer (`ModelTileTriangleCuller`), its `triangleCount` triangles, rather than the runs of the tile's own. */
  drawsCulled: boolean;
  triangleCount: number;
}

export class ModelTileRenderSubsystem implements RenderSubsystem {
  readonly name = "ModelTiles";
  readonly layers: readonly RenderLayer[] = ["sceneModels", "shadowCasters", "farShadowCasters"];
  private readonly rise = new ExtrusionRise<VisibleTile>(visibleTileKey);
  private drawItems: DrawItem[] = [];
  private casterItems: DrawItem[] = [];
  private readonly frustum = new Frustum();
  private readonly shadowFrustum = new Frustum();
  private readonly composed: Mat4 = new Float64Array(16);
  /** The frame's camera matrix, what the triangle culling is for. */
  private projectionView: Mat4 = new Float64Array(16);
  /** The world pass's record of each draw item, written in `prepareGPU`. */
  private records: number[] = [];
  /** The frame's depth bias, the settings' at the camera's zoom (read each frame, so a change applies live): the draws and the culling take the same. */
  private depthBias = 0;
  /** How many model tiles the last frame waited for (`FrameEvent.pendingSceneModelMeshes` adds them). */
  pendingCount = 0;

  constructor(
    private readonly pipelines: ModelPipelines,
    private readonly frame: StandingFrame,
    /** `undefined` for a map without a model archive: the subsystem then does nothing. */
    private readonly store: ModelTileStore<ModelTileMesh> | undefined,
    private readonly uploader: ModelTileUploader | undefined,
    private readonly settings: () => ModelTileDrawSettings,
    private readonly input: () => ModelTileFrameInput,
    private readonly sceneModelState: SceneModelFrameState,
    /** `undefined` draws every model of a tile in view, every triangle. */
    private readonly culler: ModelTileTriangleCuller | undefined,
    private readonly sampleCount: number,
  ) {}

  /** Whether a tile is still rising or being written: the frames keep coming. */
  get isActive(): boolean {
    return this.rise.isAnimating || (this.uploader?.isUploading ?? false);
  }

  update(context: FrameContext): void {
    this.drawItems = [];
    this.casterItems = [];
    this.records = [];
    this.pendingCount = 0;
    const store = this.store;
    if (store === undefined) return;
    this.uploader?.pump();
    const input = this.input();
    const settings = this.settings();
    const isRaised = input.renderSurfaceMode === "flat" && context.planningZoom >= settings.minimumZoom;
    const wanted = wantedModelTiles(input.visibleTiles);
    const wrapsByTile = new Map<string, number[]>();
    const tiles: VisibleTile["tile"][] = [];
    for (const w of wanted) {
      const key = tileKey(w.tile);
      let wraps = wrapsByTile.get(key);
      if (wraps === undefined) {
        wraps = [];
        wrapsByTile.set(key, wraps);
        tiles.push(w.tile);
      }
      wraps.push(w.worldWrap);
    }
    const { ready, pending } = store.meshes(tiles);
    this.pendingCount = pending.length;
    const state = this.sceneModelState;
    // The buildings of these tiles wait for them: a model may stand in for
    // some of them, and they are left out from their first frame.
    state.pendingModelTiles = new Set(pending.map(tileKey));
    // Below their zoom the tiles draw nothing and stand in for no building:
    // the buildings, if they draw there, stay whole.
    const drawn: VisibleTile[] = isRaised ? ready.flatMap((mesh) => (wrapsByTile.get(tileKey(mesh.tile)) ?? []).map((worldWrap) => ({ tile: mesh.tile, worldWrap }))) : [];
    const time = input.timeSeconds;
    this.rise.advance(drawn, time, settings.riseSeconds);
    state.isRising ||= this.rise.isAnimating;
    if (drawn.length === 0) return;

    this.frustum.update(input.projectionView);
    this.projectionView = input.projectionView;
    const shadowState = input.shadowFrameState;
    if (shadowState !== undefined) this.shadowFrustum.update(ShadowFrameState.casterCullingProjectionView(shadowState));
    let replaced = state.replacedBuildings;
    const center: [number, number, number] = [0, 0, 0];
    const grid = sampleGrid(this.sampleCount);
    this.depthBias = settings.depthBias(context.planningZoom);
    const culledMeshes = new Set<ModelTileMesh>();
    for (const mesh of ready) {
      // Loaded, so shown, in view or not: its buildings go.
      replaced = replaced.union(mesh.replacedBuildingIDs);
      for (const worldWrap of wrapsByTile.get(tileKey(mesh.tile)) ?? []) {
        const placement = modelTilePlacement(mesh.tile, worldWrap, input.flatRenderState);
        const placeIn = { tile: mesh.tile, worldWrap };
        // Coming up out of the ground whole: the tile is lowered by what is
        // left of its tallest model's height, so its models keep their shape
        // and the tallest tops come out first.
        const heightScale = this.rise.heightScale(placeIn, time);
        const depth = (1 - heightScale) * Math.max(mesh.boundsMaximum[2], 0) * placement.scale;
        const model = new Float64Array(16);
        mat4Multiply(model, placement.modelMatrix, mesh.positionMatrix);
        model[14] = model[14]! - depth;
        const radius = (Math.hypot(mesh.boundsMaximum[0] - mesh.boundsMinimum[0], mesh.boundsMaximum[1] - mesh.boundsMinimum[1], mesh.boundsMaximum[2] - mesh.boundsMinimum[2]) / 2) * placement.scale;
        if (!(radius > 0)) continue;
        for (let axis = 0; axis < 3; axis++) center[axis] = placement.origin[axis]! + ((mesh.boundsMinimum[axis]! + mesh.boundsMaximum[axis]!) / 2) * placement.scale;
        center[2] -= depth;
        const footprint = [
          placement.origin[0] + mesh.boundsMinimum[0] * placement.scale,
          placement.origin[1] + mesh.boundsMinimum[1] * placement.scale,
          placement.origin[0] + mesh.boundsMaximum[0] * placement.scale,
          placement.origin[1] + mesh.boundsMaximum[1] * placement.scale,
        ] as const;
        const isRising = heightScale < 1;
        const item: DrawItem = { mesh, model, isRising, caster: { resident: mesh, placeIn, quarters: quartersAll }, footprint, runs: [], drawsCulled: false, triangleCount: 0 };
        // A tile casts once it has risen.
        if (!isRising && shadowState !== undefined && this.shadowFrustum.isSphereVisible(center, radius)) {
          this.casterItems.push(item);
          state.staticShadowCasters.push(item.caster);
        }
        if (this.frustum.isSphereVisible(center, radius)) this.addDrawItem(item, input.projectionView, context, grid, culledMeshes);
      }
    }
    state.replacedBuildings = replaced;
    state.hasShadowCasters ||= this.casterItems.length > 0;
    state.hasDrawnModels ||= this.drawItems.length > 0;
  }

  /**
   * A tile in the world pass: the runs of its models in view and large
   * enough, and, for a standing tile, its triangles culled on the GPU into
   * its culled index buffer. A tile drawn twice in a frame (two world
   * copies in view) culls for its first copy and draws its runs for the
   * other, and a rising one draws its runs: the culled buffer is the
   * frame's for one matrix, and a rising tile is a few frames.
   */
  private addDrawItem(item: DrawItem, projectionView: Mat4, context: FrameContext, grid: SampleGrid, culledMeshes: Set<ModelTileMesh>): void {
    const { mesh } = item;
    if (mesh.models.length === 0) {
      item.runs = [0, Math.floor(mesh.indexCount / 3)];
      item.triangleCount = item.runs[1]!;
    } else {
      mat4Multiply(this.composed, projectionView, item.model);
      item.runs = visibleModelRuns(mesh.models, mesh.boundsMinimum, mesh.boundsMaximum, this.composed, context.drawWidth, context.drawHeight, grid);
      item.triangleCount = runTriangleCount(item.runs);
    }
    if (item.triangleCount === 0) return;
    if (this.culler !== undefined && mesh.models.length > 0 && !item.isRising && !culledMeshes.has(mesh)) {
      culledMeshes.add(mesh);
      item.drawsCulled = true;
    }
    this.drawItems.push(item);
  }

  /** The world pass's records, written now so the culled draws name theirs, and the triangle culling. */
  prepareGPU(context: FrameContext, encoder: GPUCommandEncoder, timestamps: (label: string) => { timestampWrites?: GPUComputePassTimestampWrites }): void {
    this.records = this.drawItems.map((item) => this.writeRecord(context, item.model, this.depthBias));
    const culler = this.culler;
    if (culler === undefined) return;
    const jobs: TriangleCullJob[] = [];
    this.drawItems.forEach((item, i) => {
      if (item.drawsCulled) jobs.push({ mesh: item.mesh, projectionView: this.projectionView, model: item.model, depthBias: this.depthBias, runs: item.runs, triangleCount: item.triangleCount, record: this.records[i]! });
    });
    culler.encode(encoder, jobs, context.drawWidth, context.drawHeight, sampleGrid(this.sampleCount), timestamps);
  }

  contributeAvailability(availability: { sceneModelsEnabled: boolean }): void {
    availability.sceneModelsEnabled ||= this.drawItems.length > 0;
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const slot = ShadowCascadeAtlas.slotOfCasterLayer(layer);
    if (slot !== undefined) {
      this.drawCasters(pass, context, slot);
      return;
    }
    if (layer === "sceneModels") this.drawModels(pass, context);
  }

  /**
   * The models in the world pass: opaque, depth tested and written, raising
   * the surface mask bit where they land, nearer in depth than they stand by
   * the bias at the camera's zoom. A tile binds its buffers and its texture
   * array once and draws its culled triangles in one indirect call, or its
   * runs of models one call each.
   */
  private drawModels(pass: GPURenderPassEncoder, context: FrameContext): void {
    if (this.drawItems.length === 0) return;
    const p = this.pipelines.pipelines;
    const records = this.records;
    pass.setBindGroup(0, this.frame.bindGroup());
    pass.setBindGroup(1, context.drawParameters.bindGroup(this.pipelines.standingDrawLayout));
    pass.setStencilReference(TileSourceStencilPriority.surfaceMaskBit);
    // Every standing tile under one pipeline, then the rising ones with what is below the ground dropped.
    for (const rising of [false, true]) {
      let selected = false;
      this.drawItems.forEach((item, i) => {
        if (item.isRising !== rising) return;
        if (!selected) {
          pass.setPipeline(rising ? p.modelTileClipped : p.modelTile);
          selected = true;
        }
        pass.setBindGroup(2, item.mesh.textureGroup);
        pass.setVertexBuffer(0, item.mesh.vertexBuffer);
        const culled = item.drawsCulled ? this.culler?.drawArguments(item.mesh) : undefined;
        if (culled !== undefined) {
          pass.setIndexBuffer(item.mesh.culledIndexBuffer, "uint32");
          pass.drawIndexedIndirect(culled, 0);
          return;
        }
        pass.setIndexBuffer(item.mesh.indexBuffer, "uint32");
        for (let run = 0; run < item.runs.length; run += 2) pass.drawIndexed(item.runs[run + 1]! * 3, 1, item.runs[run]! * 3, 0, records[i]!);
      });
    }
  }

  /**
   * Depth-only replay of the tiles from the light's camera, both faces, one
   * draw a tile. A pass over a kept slice draws the casters it adds alone,
   * or every caster over the region it draws again.
   */
  private drawCasters(pass: GPURenderPassEncoder, context: FrameContext, slot: ShadowCascadeSlot): void {
    const shadows = this.frame.shadows.frameState;
    const lightProjectionView = shadows === undefined ? undefined : ShadowFrameState.lightProjectionView(shadows, slot);
    if (lightProjectionView === undefined || this.casterItems.length === 0) return;
    const plan = ShadowFrameState.casterPass(shadows!, slot);
    const added = plan?.region === undefined ? plan?.added : undefined;
    const hole = plan?.hole;
    let bound = false;
    for (const item of this.casterItems) {
      if (added !== undefined && !added.has(ShadowMapReuseController.casterKey(item.caster))) continue;
      // The hole holds the longest shadow on the plane: a tile whose whole footprint lies in it casts only where the near window is read.
      if (hole !== undefined && footprintInDisc(item.footprint, hole.x, hole.y, hole.radius)) continue;
      if (!bound) {
        pass.setPipeline(this.pipelines.pipelines.modelTileCaster);
        pass.setBindGroup(0, this.pipelines.emptyGroup);
        bound = true;
      }
      mat4Multiply(this.composed, lightProjectionView, item.model);
      const instance = this.writeRecord(context, this.composed, 0);
      pass.setBindGroup(1, context.drawParameters.bindGroup(this.pipelines.standingDrawLayout));
      pass.setVertexBuffer(0, item.mesh.vertexBuffer);
      pass.setIndexBuffer(item.mesh.indexBuffer, "uint32");
      pass.drawIndexed(item.mesh.indexCount, 1, 0, 0, instance);
    }
  }

  /** One draw's record: the matrix and the bias. */
  private writeRecord(context: FrameContext, matrix: Mat4, depthBias: number): number {
    const record = context.drawParameters.allocate();
    const f = context.drawParameters.f32;
    for (let i = 0; i < 16; i++) f[record.index + i] = matrix[i]!;
    f[record.index + 16] = depthBias;
    return record.instance;
  }

  /** Lets go of every loaded tile and restarts the rise. */
  destroy(): void {
    this.culler?.destroy();
    this.uploader?.destroy();
    this.store?.destroy();
    this.rise.reset();
  }
}

/** Whether a footprint (minimum x, y, maximum x, y) lies wholly inside a disc. */
function footprintInDisc(footprint: readonly [number, number, number, number], x: number, y: number, radius: number): boolean {
  const dx = Math.max(Math.abs(footprint[0] - x), Math.abs(footprint[2] - x));
  const dy = Math.max(Math.abs(footprint[1] - y), Math.abs(footprint[3] - y));
  return dx * dx + dy * dy <= radius * radius;
}
