// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The extruded buildings of the flat map, a port of the Swift
 * `BuildingExtrusionRenderSubsystem` and `BuildingExtrusionDrawer`: opaque
 * geometry straight into the world pass, before the ground, which then
 * fails its depth test under them, and the same geometry depth-only from
 * the light's camera into each window of the shadow map whose pass runs.
 *
 * The buildings draw from a camera zoom on
 * (`ExtrusionSettings.buildingsMinimumZoom`), from the building coverage
 * (`BuildingCoveragePlanner`): each tile whole in its own square and never
 * two that overlap, so nothing keeps tiles apart per pixel, and the casters
 * are the same partition, so a building casts once a window. Each tile's
 * buildings grow out of the flat map from the frame they first draw in
 * (`ExtrusionRise`), their shadows with them, and a tile taking over from
 * the tiles that drew there keeps their height. Leaving the zoom, they are
 * gone at once.
 *
 * A placement draws one call for every run of consecutive quarters it
 * draws (`PlaceTile.quarters`), from the tile's own index buffer. The world
 * pass leaves out the quarters out of the camera's view, and each window's
 * casters the quarters outside the window's square in the light's view
 * (`visibleQuarters`, neither in Swift), and the far window's casters the
 * quarters inside its caster hole (`ShadowCasterPassPlan.hole`). A pass
 * that only adds casters over its kept slice draws those alone
 * (`ShadowCasterPassPlan.added`), and a pass that clears the region the
 * casters that left covered draws every caster over that region. On the ground relief each
 * building stands level at the terrain's height under its anchor
 * (`BuildingReliefLifts`, tile-extruded.wgsl `kExtrudedRelief`), its tile's
 * lifts bound at group 3.
 *
 * A building a drawn model stands in for (`SceneModelFrameState.replacedBuildings`)
 * is left out of both the world pass and the shadow casters, and its tile
 * still draws in one call a run, from a working index buffer without it
 * (`HiddenBuildingIndexBuffers`, filled by a compute pass in `prepareGPU`).
 * A tile's buildings also wait for the model tile over them
 * (`SceneModelFrameState.pendingModelTiles`), so the ones a model stands in
 * for are left out from their first frame.
 */

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { type Mat4, mat4Multiply } from "../../math/matrix.ts";
import type { RenderLayer } from "../../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../../render/frame-engine.ts";
import { ShadowCascadeAtlas } from "../../shadows/shadow-cascade-atlas.ts";
import { ShadowFrameState } from "../../shadows/shadow-frame-state.ts";
import { type ShadowCasterKeyPlacement, type ShadowCasterPassPlan, ShadowMapReuseController } from "../../shadows/shadow-map-reuse-controller.ts";
import type { ExtrusionSettings } from "../../configuration/scene-settings.ts";
import { ExtrusionRise } from "../../utils/extrusion-rise.ts";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import type { FlatResidentTile } from "../drawers/flat-map-surface-drawer.ts";
import { BuildingRiseCoverage } from "../placement/building-rise-coverage.ts";
import { type PlaceTile, visibleTileKey, type VisibleTile } from "../placement/place-tile.ts";
import type { StandingPipelines } from "../pipelines/standing-pipelines.ts";
import { standingGeometry, type ExtrudedGeometry } from "../store/standing-geometry.ts";
import type { GpuTile } from "../store/tile-gpu.ts";
import { quarterRuns } from "../tile-quarters.ts";
import { quartersOutsideDisc, visibleQuarters } from "../visibility/quarter-frustum.ts";
import { squaresOverlap, standingCeiling, type StandingFrame, type StandingFrameState } from "./standing-frame.ts";
import { BuildingReliefLifts, type BuildingAnchorTile, type BuildingLifts } from "../relief/lifts/building-relief-lifts.ts";
import { BUILDING_LIFT_UNIFORM_BYTES } from "../pipelines/standing-pipelines.ts";
import { modelTileKeyOver, ReplacedBuildings, type SceneModelFrameState } from "../../render/core/scene-model-frame-state.ts";
import { BuildingIndexCopier } from "../drawers/building-index-copier.ts";
import { HiddenBuildingIndexBuffers, type HiddenBuildingIndices, type HiddenBuildingTile } from "../drawers/hidden-building-index-buffers.ts";
import { tileBuildingRanges } from "../tile-building-range.ts";

/** The zoom of the model tiles the buildings wait for (`ModelTileStore.tileZoom`). */
const modelTileZoom = 14;

/** What the buildings read of the models: the frame's model state, and whether a resident tile still lives (the working buffers of the released ones go). */
export interface BuildingModelHooks {
  readonly state: SceneModelFrameState;
  readonly isLive: (resident: FlatResidentTile) => boolean;
}

/** The caster identity of a tile drawing nothing: every building of it is hidden. */
const hiddenWhole = {};

/**
 * How many times the shadow map is drawn again while a tile rises: its
 * shadows grow in these steps (every 0.1 s over the default 0.6 s rise), not
 * every frame, so a frame of a rising city pays for a caster pass only now
 * and then. Not in Swift, which draws the casters again every frame of the
 * rise (docs/STATUS.md, stage 4). A step adds over the kept shadow map the
 * tiles that rose alone (`ShadowCasterPassPlan.added`).
 */
export const riseShadowSteps = 6;

const noneReplaced = ReplacedBuildings.none;

export class BuildingExtrusionSubsystem implements RenderSubsystem {
  readonly name = "BuildingExtrusion";
  readonly layers: readonly RenderLayer[] = ["buildingExtrusion", "shadowCasters", "farShadowCasters"];
  private readonly rise = new ExtrusionRise<VisibleTile>(visibleTileKey);
  /** The frame's drawn placements, how far each has risen (kept off zero while it draws) and its lifts on the relief. */
  private drawn: {
    placement: PlaceTile<FlatResidentTile & BuildingAnchorTile>;
    geometry: ExtrudedGeometry;
    heightScale: number;
    lifts: GPUBindGroup | undefined;
    liftsKey: BuildingLifts | undefined;
    /** What it casts as: the placement and its rise step (`riseShadowSteps`). */
    caster: ShadowCasterKeyPlacement;
    /** What its buildings draw from, the ones the models stand in for left out. */
    indices: HiddenBuildingIndices;
  }[] = [];
  private readonly copier: BuildingIndexCopier;
  private readonly hidden: HiddenBuildingIndexBuffers<FlatResidentTile>;
  private readonly hiddenTiles = new WeakMap<GpuTile, HiddenBuildingTile>();
  private readonly reliefLifts = new BuildingReliefLifts<FlatResidentTile & BuildingAnchorTile>();
  /** Each tile's lifts on the GPU, by the lifts they were made from. */
  private liftGroups = new Map<BuildingLifts, { buffer: GPUBuffer; group: GPUBindGroup }>();
  private readonly liftUniform: GPUBuffer;
  private readonly liftUniformStaging = new Float32Array(BUILDING_LIFT_UNIFORM_BYTES / 4);
  /** The group of a draw with no lifts: one lift of 0 under the frame's uniform. */
  private readonly emptyLifts: GPUBindGroup;
  private readonly emptyLiftBuffer: GPUBuffer;
  /** A shadow signature of the lifts: the casters are drawn again when the buildings stand elsewhere. */
  private liftSignature = 0;
  private readonly coverage = new BuildingRiseCoverage();
  private signature = 0;
  private readonly styleGroups = new WeakMap<GpuTile, GPUBindGroup>();
  private readonly model: Mat4 = new Float64Array(16);
  private readonly composed: Mat4 = new Float64Array(16);

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: StandingPipelines,
    private readonly frame: StandingFrame,
    private readonly extrusion: ExtrusionSettings,
    private readonly state: () => StandingFrameState,
    /** The models, `undefined` for a frame that has none to hide buildings for. */
    private readonly models?: BuildingModelHooks,
  ) {
    this.copier = new BuildingIndexCopier(device);
    this.hidden = new HiddenBuildingIndexBuffers<FlatResidentTile>(
      (resident, layout) => {
        const geometry = standingGeometry(resident.gpu).extruded!;
        return this.copier.make({ arena: resident.gpu.buffer, firstIndex: geometry.firstIndex, indexFormat: geometry.indexFormat }, layout);
      },
      (resident) => models?.isLive(resident) ?? false,
    );
    this.liftUniform = device.createBuffer({ label: "building lift", size: BUILDING_LIFT_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.emptyLiftBuffer = device.createBuffer({ label: "building lifts empty", size: 4, usage: GPUBufferUsage.STORAGE });
    this.emptyLifts = this.liftGroup(this.emptyLiftBuffer);
  }

  /** The placements whose buildings draw this frame, with the step of their rise: the shadow gate's casters. */
  get drawnPlacements(): readonly ShadowCasterKeyPlacement[] {
    return this.drawn.map((d) => d.caster);
  }

  /** How far the drawn buildings have risen, summed (the Swift `buildingRiseSignature`, the roofs' labels follow it). */
  get riseSignature(): number {
    return this.signature;
  }

  /**
   * The relief's lifts: a lift redraws the shadow map. The rise steps
   * (`riseShadowSteps`) travel in each placement's `riseStep`
   * (`drawnPlacements`), so a step adds the tiles that rose over the map.
   */
  get shadowRiseSignature(): number {
    return this.liftSignature;
  }

  /** How far the buildings over each point have risen (the labels on the roofs). */
  get riseCoverage(): BuildingRiseCoverage {
    return this.coverage;
  }

  /** Whether a tile is still rising and the frames have to keep coming. */
  get isRising(): boolean {
    return this.rise.isAnimating;
  }

  update(context: FrameContext): void {
    const { placements, renderSurfaceMode, timeSeconds } = this.state();
    const isRaised = renderSurfaceMode === "flat" && context.planningZoom >= this.extrusion.buildingsMinimumZoom;
    // A tile's buildings wait for the model tile over it, if any, in hand.
    const pendingModelTiles = this.models?.state.pendingModelTiles;
    const waits = (p: (typeof placements)[number]): boolean => pendingModelTiles !== undefined && pendingModelTiles.size > 0 && pendingModelTiles.has(modelTileKeyOver(p.resident.tile, modelTileZoom));
    const keys = isRaised ? placements.filter((p) => !waits(p)).map((p) => p.placeIn) : [];
    // A tile taking over the ground of standing buildings keeps their height.
    this.rise.advance(keys, timeSeconds, this.extrusion.riseSeconds, squaresOverlap);
    this.drawn = [];
    this.coverage.clear();
    this.signature = 0;
    this.liftSignature = 0;
    const relief = this.state().relief;
    if (!isRaised) {
      this.reliefLifts.update([], undefined);
      return;
    }
    const withBuildings = (placements as readonly PlaceTile<FlatResidentTile & BuildingAnchorTile>[]).filter((p) => standingGeometry(p.resident.gpu).extruded !== undefined && !waits(p));
    // The buildings the frame's models stand in for, left out of the tiles that hold them.
    this.hidden.update(this.models?.state.replacedBuildings ?? noneReplaced);
    // Each placement's lifts over the relief, made once a terrain.
    const lifts = this.reliefLifts.update(withBuildings, relief);
    if (relief?.isActive === true) {
      this.liftUniformStaging[0] = relief.worldUnitsPerMetre;
      this.liftUniformStaging[1] = relief.datumMetres;
      this.liftUniformStaging[2] = relief.strength;
      this.device.queue.writeBuffer(this.liftUniform, 0, this.liftUniformStaging);
      this.liftSignature = relief.version * 1e-3 + relief.datumMetres * 1e-6 + relief.strength * 1e-2;
    }
    withBuildings.forEach((placement, index) => {
      const geometry = standingGeometry(placement.resident.gpu).extruded!;
      const scale = this.rise.heightScale(placement.placeIn, timeSeconds);
      // Kept off zero while the tile draws: the roofs' normals come out of
      // the scaled matrix and are normalized in the shader.
      const heightScale = Math.max(scale, 0.001);
      const tileLifts = lifts[index];
      // The shadow map follows the rise in steps (`riseShadowSteps`), the
      // last one the full height.
      const riseStep = Math.floor(scale * riseShadowSteps) / riseShadowSteps;
      const indices = this.hidden.indices(placement.resident, this.hiddenTile(placement.resident, geometry));
      // A tile with buildings left out casts as another caster: its shadows change with them.
      const resident = indices.kind === "whole" ? placement.resident : indices.kind === "working" ? indices.buffer : hiddenWhole;
      const caster = { resident, placeIn: placement.placeIn, quarters: placement.quarters, riseStep };
      this.drawn.push({ placement, geometry, heightScale, lifts: tileLifts === undefined ? undefined : this.liftsOnGpu(tileLifts), liftsKey: tileLifts, caster, indices });
      this.coverage.add(placement.placeIn.tile, placement.quarters, scale);
      this.signature += heightScale;
    });
  }

  /** A tile's buildings as the hidden buildings read them: its ranges, its zoom, its indices' count and quarters. */
  private hiddenTile(resident: FlatResidentTile, geometry: ExtrudedGeometry): HiddenBuildingTile {
    let tile = this.hiddenTiles.get(resident.gpu);
    if (tile === undefined) {
      tile = { zoom: resident.tile.z, ranges: tileBuildingRanges(resident.gpu.meta.buildingRanges), indexCount: geometry.indexCount, quarterIndexStarts: geometry.quarterIndexStarts };
      this.hiddenTiles.set(resident.gpu, tile);
    }
    return tile;
  }

  /** The working index buffers made this frame are filled before the frame's passes. */
  prepareGPU(_context: FrameContext, encoder: GPUCommandEncoder): void {
    this.copier.encode(encoder);
  }

  /** A tile's lifts on the GPU, made once for its lifts. */
  private liftsOnGpu(lifts: BuildingLifts): GPUBindGroup {
    let entry = this.liftGroups.get(lifts);
    if (entry === undefined) {
      const buffer = this.device.createBuffer({ label: "building lifts", size: Math.max(4, lifts.metres.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, lifts.metres as Float32Array<ArrayBuffer>);
      entry = { buffer, group: this.liftGroup(buffer) };
      this.liftGroups.set(lifts, entry);
    }
    return entry.group;
  }

  private liftGroup(buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      label: "building lifts",
      layout: this.pipelines.liftsLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: this.liftUniform } },
      ],
    });
  }

  /** Lets go of the lifts' buffers no drawn placement reads, after the frame that may read them is submitted. */
  frameCommitted(): void {
    this.copier.frameCommitted();
    if (this.liftGroups.size === 0) return;
    const held = new Set<BuildingLifts>();
    for (const d of this.drawn) if (d.liftsKey !== undefined) held.add(d.liftsKey);
    if (held.size === this.liftGroups.size) return;
    const kept = new Map<BuildingLifts, { buffer: GPUBuffer; group: GPUBindGroup }>();
    for (const [key, entry] of this.liftGroups) {
      if (held.has(key)) kept.set(key, entry);
      else entry.buffer.destroy();
    }
    this.liftGroups = kept;
  }

  destroy(): void {
    this.hidden.destroy();
    this.copier.destroy();
    for (const entry of this.liftGroups.values()) entry.buffer.destroy();
    this.liftGroups.clear();
    this.liftUniform.destroy();
    this.emptyLiftBuffer.destroy();
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const { renderSurfaceMode } = this.state();
    if (renderSurfaceMode !== "flat" || this.drawn.length === 0) return;
    const slot = ShadowCascadeAtlas.slotOfCasterLayer(layer);
    if (slot !== undefined) {
      const shadows = this.frame.shadows.frameState;
      const lightProjectionView = shadows === undefined ? undefined : ShadowFrameState.lightProjectionView(shadows, slot);
      if (lightProjectionView) this.drawCasters(pass, context, lightProjectionView, ShadowFrameState.casterPass(shadows!, slot));
      return;
    }
    if (layer === "buildingExtrusion") this.drawBuildings(pass, context);
  }

  /** The buildings into the world pass, one draw a run of quarters, back faces culled. */
  private drawBuildings(pass: GPURenderPassEncoder, context: FrameContext): void {
    const { flatRenderState } = this.state();
    pass.setBindGroup(0, this.frame.bindGroup());
    // World units per metre along z for the depth cue's gradient: the tile
    // zoom cancels between the vertices' metres and the tile's matrix (the
    // style's anchor zoom of 16), so one constant serves every tile.
    const metersToWorldZ = flatRenderState.renderMapSize / (4096 * 65536);
    const instances = this.drawn.map(({ placement, heightScale }) => {
      const record = this.writeRecord(context, placement, heightScale, undefined);
      context.drawParameters.f32[record.index + 16] = metersToWorldZ;
      return record.instance;
    });
    const draws = context.drawParameters.bindGroup(this.pipelines.drawLayout);
    pass.setBindGroup(1, draws);
    const { projectionView } = this.state();
    const ceiling = standingCeiling(flatRenderState.renderMapSize);
    let selectedRelief: boolean | undefined;
    this.drawn.forEach(({ placement, geometry, lifts, indices }, i) => {
      if (indices.kind === "none") return;
      const tile = placement.resident.tile;
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, placement.placeIn.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
      // On the relief the buildings stand on the terrain, so their ceiling is the frame's highest ground too.
      const quarters = lifts === undefined ? visibleQuarters(projectionView, ox, oy, size, ceiling, placement.quarters, geometry.quarterIndexStarts.length === 5) : placement.quarters;
      if (quarters === 0) return;
      // The relief variant with the tile's lifts for a tile whose terrain is in, the plain one for the rest.
      if ((lifts !== undefined) !== selectedRelief) {
        selectedRelief = lifts !== undefined;
        pass.setPipeline(selectedRelief ? this.pipelines.buildingRelief : this.pipelines.building);
      }
      pass.setBindGroup(3, lifts ?? this.emptyLifts);
      pass.setBindGroup(2, this.styles(placement.resident.gpu, geometry));
      // The surface mask bit where the building lands. The priority below
      // it is not tested (the coverage never overlaps), it keeps the
      // reference shaped like every other tile pass's.
      pass.setStencilReference(TileSourceStencilPriority.reference(placement.resident.tile.z) | TileSourceStencilPriority.surfaceMaskBit);
      this.drawRuns(pass, placement, geometry, indices, instances[i]!, quarters);
    });
  }

  /**
   * The same geometry depth-only from the light's camera: exactly what the
   * world pass draws, both faces. A pass over a kept slice draws the casters
   * it adds alone, and the quarters inside the pass's hole are left out.
   */
  private drawCasters(pass: GPURenderPassEncoder, context: FrameContext, lightProjectionView: Mat4, plan: ShadowCasterPassPlan | undefined): void {
    pass.setBindGroup(0, this.pipelines.emptyGroup);
    pass.setBindGroup(2, this.pipelines.emptyGroup);
    let boundDraws: GPUBindGroup | undefined;
    let selectedRelief: boolean | undefined;
    const { flatRenderState } = this.state();
    const ceiling = standingCeiling(flatRenderState.renderMapSize);
    // A pass over a kept slice draws the casters it adds alone, or every
    // caster over the region it draws again, culled by the region's camera.
    const region = plan?.region;
    const added = region === undefined ? plan?.added : undefined;
    const cullingProjectionView = region?.cullingProjectionView ?? lightProjectionView;
    const hole = plan?.hole;
    for (const { placement, geometry, heightScale, lifts, caster, indices } of this.drawn) {
      if (indices.kind === "none") continue;
      if (added !== undefined && !added.has(ShadowMapReuseController.casterKey(caster))) continue;
      // A caster whose box lies outside the window's square in the light's
      // view casts outside it too: the light projects along its own direction.
      const tile = placement.resident.tile;
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, placement.placeIn.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
      const byQuarters = geometry.quarterIndexStarts.length === 5;
      let quarters = lifts === undefined ? visibleQuarters(cullingProjectionView, ox, oy, size, ceiling, placement.quarters, byQuarters) : placement.quarters;
      // The hole holds the longest shadow on the plane: a building lifted
      // by the relief may throw farther, down a slope, and always casts.
      if (hole !== undefined && lifts === undefined) quarters = quartersOutsideDisc(ox, oy, size, quarters, byQuarters, hole.x, hole.y, hole.radius);
      if (quarters === 0) continue;
      if ((lifts !== undefined) !== selectedRelief) {
        selectedRelief = lifts !== undefined;
        pass.setPipeline(selectedRelief ? this.pipelines.casterRelief : this.pipelines.caster);
      }
      pass.setBindGroup(3, lifts ?? this.emptyLifts);
      const record = this.writeRecord(context, placement, heightScale, lightProjectionView);
      const draws = context.drawParameters.bindGroup(this.pipelines.drawLayout);
      if (draws !== boundDraws) pass.setBindGroup(1, (boundDraws = draws));
      this.drawRuns(pass, placement, geometry, indices, record.instance, quarters);
    }
  }

  /**
   * The placement's record: the tile's model matrix with the rise in its z
   * scale, the light's projection-view times it for the casters (composed
   * in double precision, the matrices' own).
   */
  private writeRecord(context: FrameContext, placement: PlaceTile<FlatResidentTile>, heightScale: number, lightProjectionView: Mat4 | undefined): { instance: number; index: number } {
    const { flatRenderState } = this.state();
    const tile = placement.resident.tile;
    const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, placement.placeIn.worldWrap, flatRenderState.pan, flatRenderState.renderMapSize);
    const scale = size / 4096;
    const m = this.model;
    m.fill(0);
    m[0] = scale;
    m[5] = scale;
    m[10] = scale * heightScale;
    m[12] = ox;
    m[13] = oy;
    m[15] = 1;
    const matrix = lightProjectionView ? mat4Multiply(this.composed, lightProjectionView, m) : m;
    const record = context.drawParameters.allocate();
    const f = context.drawParameters.f32;
    for (let i = 0; i < 16; i++) f[record.index + i] = matrix[i]!;
    // The model's z scale: a lift in world units rises by it in the tile's units.
    f[record.index + 17] = m[10]!;
    return record;
  }

  /**
   * One draw a run of the quarters the placement draws, a whole tile in
   * one: from the tile's own indices, or from its working buffer when the
   * frame leaves some buildings out.
   */
  private drawRuns(pass: GPURenderPassEncoder, placement: PlaceTile<FlatResidentTile>, geometry: ExtrudedGeometry, indices: HiddenBuildingIndices, instance: number, quarters: number): void {
    const buffer = placement.resident.gpu.buffer;
    pass.setVertexBuffer(0, buffer, geometry.vertexOffset, geometry.vertexByteCount);
    const working = indices.kind === "working" ? indices : undefined;
    pass.setIndexBuffer(working?.buffer ?? buffer, geometry.indexFormat);
    const indexCount = working?.indexCount ?? geometry.indexCount;
    const firstIndex = working === undefined ? geometry.firstIndex : 0;
    for (const [start, end] of quarterRuns(working?.quarterStarts ?? geometry.quarterIndexStarts, [0, indexCount], quarters)) {
      const count = Math.min(end, indexCount) - start;
      if (count > 0) pass.drawIndexed(count, 1, firstIndex + start, 0, instance);
    }
  }

  /** A tile's building styles as storage, made on its first draw. */
  private styles(gpu: GpuTile, geometry: ExtrudedGeometry): GPUBindGroup {
    let group = this.styleGroups.get(gpu);
    if (!group) {
      group = this.device.createBindGroup({
        label: "extruded styles",
        layout: this.pipelines.extrudedStylesLayout,
        entries: [{ binding: 0, resource: { buffer: gpu.buffer, offset: geometry.stylesOffset, size: geometry.stylesByteCount } }],
      });
      this.styleGroups.set(gpu, group);
    }
    return group;
  }
}
