// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Draws the app's scene models, a port of the Swift
 * `SceneModelRenderSubsystem` and `SceneModelDrawer`: on the flat map, on
 * the globe and through the morph between them, each model rigid on the
 * surface frame under its anchor (`SceneModelAnchorMath`), in the scene
 * models' layer and in the shadow casters'.
 *
 * Each frame it applies the controller's changes to the presentation
 * (`SceneModelPresentationStateStore`, the moves, turns and flights), asks
 * the mesh store for the meshes of the sources in use, culls the models by
 * the camera's frustum and the globe's horizon gate (and the casters by the
 * light's frustum alone, a model outside the view still casts into it), and
 * hands the selection the hit volumes of the models it drew. A model that
 * cuts into the ground draws in the four steps of the ground cut
 * (scene-model.wgsl).
 *
 * It updates first of the models, and starts the frame's model state over
 * (`SceneModelFrameState`): the model tiles add to it after.
 *
 * The per-draw records are larger than the shared ones (a matrix, the
 * ground plane and the base colour, 128 bytes), so they live in a storage
 * buffer of the subsystem's own, read at the draw's `firstInstance` as the
 * shared ones are (decision B6), written once a frame (`flush`).
 */

import { Frustum } from "../camera/frustum.ts";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { type Mat4, mat4Multiply } from "../math/matrix.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import type { RenderLayer } from "../render/core/render-layer.ts";
import type { SceneModelFrameState } from "../render/core/scene-model-frame-state.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import { ShadowCascadeAtlas, type ShadowCascadeSlot } from "../shadows/shadow-cascade-atlas.ts";
import { ShadowFrameState } from "../shadows/shadow-frame-state.ts";
import { TileSourceStencilPriority } from "../tile/drawers/depth-rank.ts";
import type { StandingFrame } from "../tile/subsystems/standing-frame.ts";
import type { Vec3 } from "../math/vec.ts";
import { resolveSceneModelSource, type ResolvedSceneModelSource } from "./immersive-map-scene-model.ts";
import type { ImmersiveMapSceneModelsController } from "./immersive-map-scene-models-controller.ts";
import { type ModelPipelines, SCENE_MODEL_DRAW_BYTES } from "./pipelines/model-pipelines.ts";
import { SceneModelPresentationStateStore } from "./presentation/scene-model-presentation-state-store.ts";
import type { SceneModelPathAnimationResult } from "./scene-model-render-source.ts";
import { SceneModelAnchorMath, type SceneModelGroundPlane } from "./scene-model-anchor-math.ts";
import type { SceneModelGpuMesh } from "./scene-model-gpu-mesh.ts";
import type { SceneModelMeshStore } from "./scene-model-mesh-store.ts";
import { type SceneModelSelectionEntry, SceneModelSelectionSnapshot } from "./selection/scene-model-selection-snapshot.ts";
import { makeSceneModelsSnapshot } from "./scene-model-render-source.ts";

/** What the scene models read of the frame being drawn. */
export interface SceneModelFrameInput {
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly projectionView: Mat4;
  readonly cameraEye: Vec3;
  readonly presentation: ResolvedPresentationState;
  readonly timeSeconds: number;
  readonly frameIndex: number;
  /** The light's windows before the shadow gate, what the casters are culled by. */
  readonly shadowFrameState: ShadowFrameState | undefined;
}

interface DrawItem {
  readonly mesh: SceneModelGpuMesh;
  readonly modelMatrix: Mat4;
  readonly groundPlane: SceneModelGroundPlane;
  readonly cutsIntoGround: boolean;
}

const RECORD_FLOATS = SCENE_MODEL_DRAW_BYTES / 4;
const P = TileSourceStencilPriority;

export class SceneModelRenderSubsystem implements RenderSubsystem {
  readonly name = "SceneModels";
  readonly layers: readonly RenderLayer[] = ["sceneModels", "shadowCasters", "farShadowCasters"];
  private readonly presentation = new SceneModelPresentationStateStore();
  private drawItems: DrawItem[] = [];
  private casterItems: DrawItem[] = [];
  private readonly frustum = new Frustum();
  private readonly shadowFrustum = new Frustum();
  private records: Float32Array<ArrayBuffer> = new Float32Array(64 * RECORD_FLOATS);
  private recordBuffer: GPUBuffer;
  private recordGroup: GPUBindGroup;
  private retiredBuffers: GPUBuffer[] = [];
  private usedRecords = 0;
  private readonly matrix: Mat4 = new Float64Array(16);
  private readonly composed: Mat4 = new Float64Array(16);
  private pathResults: SceneModelPathAnimationResult[] = [];
  private pickData: SceneModelSelectionSnapshot | null = null;
  /** How many sources the last frame waited for (`FrameEvent.pendingSceneModelMeshes`). */
  pendingCount = 0;
  /** The sources resolved against the page, by the URL and format the app gave. */
  private readonly resolved = new Map<string, ResolvedSceneModelSource>();

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: ModelPipelines,
    private readonly frame: StandingFrame,
    private readonly meshes: SceneModelMeshStore<ResolvedSceneModelSource, SceneModelGpuMesh>,
    private readonly controller: () => ImmersiveMapSceneModelsController | null,
    private readonly input: () => SceneModelFrameInput,
    private readonly state: SceneModelFrameState,
    /** What relative source URLs resolve against: the page. */
    private readonly baseURL: string,
  ) {
    this.recordBuffer = this.makeRecordBuffer(64);
    this.recordGroup = this.makeRecordGroup();
  }

  /** Whether a model is moving, turning or flying: the frames keep coming. */
  get hasActiveAnimations(): boolean {
    return this.presentation.hasActiveAnimations;
  }

  /** The hit volumes of the models the last frame drew, `null` before any. */
  get selectionSnapshot(): SceneModelSelectionSnapshot | null {
    return this.pickData;
  }

  /** The flights that ended on the last frame, drained: the controller learns where they stopped and fires their completions. */
  consumePathAnimationResults(): SceneModelPathAnimationResult[] {
    const results = this.pathResults;
    this.pathResults = [];
    return results;
  }

  update(): void {
    const input = this.input();
    const time = input.timeSeconds;
    const controller = this.controller();
    if (controller !== null) {
      const snapshot = controller.consumeSnapshot();
      if (snapshot !== null) this.presentation.apply(snapshot, time);
    } else if (!this.presentation.isEmpty) {
      // A detached controller leaves no snapshot source: clear instead of drawing stale models forever.
      this.presentation.apply(makeSceneModelsSnapshot({ models: [] }), time);
    }
    const presented = this.presentation.presentedEntries(time);
    const state = this.state;
    // The frame's model state starts over: the model tiles add theirs.
    state.reset();
    state.hasActiveAnimations = this.presentation.hasActiveAnimations;
    this.pathResults.push(...this.presentation.consumePathAnimationResults());
    this.drawItems = [];
    this.casterItems = [];
    this.pendingCount = 0;
    if (presented.length === 0) {
      this.meshes.requestMeshes(new Map());
      this.pickData = null;
      return;
    }
    const sources = new Map<string, ResolvedSceneModelSource>();
    const keyOf = presented.map((model) => {
      const key = `${model.source.format ?? ""} ${model.source.url}`;
      let resolved = this.resolved.get(key);
      if (resolved === undefined) {
        try {
          resolved = resolveSceneModelSource(model.source, this.baseURL);
        } catch {
          return undefined;
        }
        this.resolved.set(key, resolved);
      }
      sources.set(resolved.key, resolved);
      return resolved.key;
    });
    const ready = this.meshes.requestMeshes(sources);
    this.pendingCount = sources.size - ready.size;
    if (ready.size === 0) {
      this.pickData = null;
      return;
    }
    const constants = new GeoScreenProjectionFrameConstants(input.drawWidth, input.drawHeight, { matrix: input.projectionView, eye: input.cameraEye }, input.presentation);
    this.frustum.update(input.projectionView);
    const shadowState = input.shadowFrameState;
    if (shadowState !== undefined) this.shadowFrustum.update(ShadowFrameState.casterCullingProjectionView(shadowState));
    const selection: SceneModelSelectionEntry[] = [];
    presented.forEach((model, index) => {
      const key = keyOf[index];
      const mesh = key === undefined ? undefined : ready.get(key);
      if (mesh === undefined) return;
      const anchor = SceneModelAnchorMath.resolveAnchor(model, mesh.localBounds, constants);
      if (!(anchor.boundingSphereRadius > 0)) return;
      const item: DrawItem = { mesh, modelMatrix: anchor.modelMatrix, groundPlane: anchor.groundPlane, cutsIntoGround: model.cutsIntoGround };
      if (shadowState !== undefined && this.shadowFrustum.isSphereVisible(anchor.boundingSphereCenter, anchor.boundingSphereRadius)) this.casterItems.push(item);
      if (!anchor.passesHorizonGate || !this.frustum.isSphereVisible(anchor.boundingSphereCenter, anchor.boundingSphereRadius)) return;
      this.drawItems.push(item);
      // Built from the drawn item: the hit volume is the geometry this frame put on screen.
      selection.push({ id: model.id, coordinate: model.coordinate, modelMatrix: anchor.modelMatrix, boundsMin: mesh.localBounds.minimum, boundsMax: mesh.localBounds.maximum });
    });
    state.hasShadowCasters = this.casterItems.length > 0;
    state.hasMovingShadowCasters = this.casterItems.length > 0;
    state.hasDrawnModels = this.drawItems.length > 0;
    this.pickData = new SceneModelSelectionSnapshot(input.frameIndex, input.drawWidth, input.drawHeight, new Float64Array(input.projectionView), input.cameraEye, selection);
    this.reserveRecords();
  }

  contributeAvailability(availability: { sceneModelsEnabled: boolean }): void {
    availability.sceneModelsEnabled ||= this.drawItems.length > 0;
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder, _context: FrameContext): void {
    const slot = ShadowCascadeAtlas.slotOfCasterLayer(layer);
    if (slot !== undefined) {
      this.drawCasters(pass, slot);
      return;
    }
    if (layer === "sceneModels") this.drawModels(pass);
  }

  /** The records the frame's draws wrote, uploaded before the submit (`FrameEngine.registerFlush`). */
  flush(): void {
    if (this.usedRecords > 0) this.device.queue.writeBuffer(this.recordBuffer, 0, this.records, 0, this.usedRecords * RECORD_FLOATS);
    this.usedRecords = 0;
  }

  /** After the frame's submit: the outgrown record buffers go. */
  frameCommitted(): void {
    for (const buffer of this.retiredBuffers) buffer.destroy();
    this.retiredBuffers = [];
  }

  destroy(): void {
    this.controller()?.cancelAllPathAnimations();
    this.recordBuffer.destroy();
    this.frameCommitted();
    this.meshes.destroy();
  }

  /**
   * The opaque models in the world pass, each submesh one draw, raising the
   * surface mask bit where they land. A model that cuts into the ground
   * takes the four draws of the ground cut instead.
   */
  private drawModels(pass: GPURenderPassEncoder): void {
    if (this.drawItems.length === 0) return;
    const p = this.pipelines.pipelines;
    pass.setBindGroup(0, this.frame.bindGroup());
    pass.setBindGroup(1, this.recordGroup);
    let current: GPURenderPipeline | undefined;
    const select = (pipeline: GPURenderPipeline): void => {
      if (pipeline !== current) pass.setPipeline((current = pipeline));
    };
    for (const item of this.drawItems) {
      const records = this.writeItemRecords(item, undefined);
      if (item.cutsIntoGround) {
        // The hole: the outline on the ground, raised. The reference carries
        // the bit the inside draw tests for and the surface mask bit both
        // draws raise.
        pass.setStencilReference(P.groundHoleBit);
        select(p.sceneModelFootprintRaise);
        this.drawGeometry(pass, item, records, false);
        pass.setStencilReference(P.groundHoleBit | P.surfaceMaskBit);
        select(p.sceneModelHoleInside);
        this.drawGeometry(pass, item, records, true);
        pass.setStencilReference(P.surfaceMaskBit);
        select(p.sceneModelHoleOutside);
        this.drawGeometry(pass, item, records, true);
        select(p.sceneModelFootprintLower);
        this.drawGeometry(pass, item, records, false);
      } else {
        pass.setStencilReference(P.surfaceMaskBit);
        select(p.sceneModel);
        this.drawGeometry(pass, item, records, true);
      }
    }
  }

  /** Depth-only replay of the meshes from the light's camera, both faces, one draw a mesh's submesh. */
  private drawCasters(pass: GPURenderPassEncoder, slot: ShadowCascadeSlot): void {
    const shadows = this.frame.shadows.frameState;
    const lightProjectionView = shadows === undefined ? undefined : ShadowFrameState.lightProjectionView(shadows, slot);
    if (lightProjectionView === undefined || this.casterItems.length === 0) return;
    pass.setPipeline(this.pipelines.pipelines.sceneModelCaster);
    pass.setBindGroup(0, this.pipelines.emptyGroup);
    pass.setBindGroup(1, this.recordGroup);
    for (const item of this.casterItems) this.drawGeometry(pass, item, this.writeItemRecords(item, lightProjectionView), false);
  }

  /**
   * Every submesh of the item, its record a submesh (`records`, in the
   * item's meshes' order), with its material for a colour draw.
   */
  private drawGeometry(pass: GPURenderPassEncoder, item: DrawItem, records: readonly number[], withMaterials: boolean): void {
    let r = 0;
    for (const mesh of item.mesh.meshes) {
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, "uint32");
      for (const submesh of mesh.submeshes) {
        const instance = records[r++]!;
        if (submesh.indexCount === 0) continue;
        if (withMaterials) pass.setBindGroup(2, submesh.textureGroup);
        pass.drawIndexed(submesh.indexCount, 1, submesh.firstIndex, 0, instance);
      }
    }
  }

  /** The item's records, one a submesh: the mesh's model matrix (the light's projection-view times it for a caster), the ground plane and the base colour. */
  private writeItemRecords(item: DrawItem, lightProjectionView: Mat4 | undefined): number[] {
    const records: number[] = [];
    const f = this.records;
    for (const mesh of item.mesh.meshes) {
      mat4Multiply(this.matrix, item.modelMatrix, mesh.localTransform);
      const matrix = lightProjectionView === undefined ? this.matrix : mat4Multiply(this.composed, lightProjectionView, this.matrix);
      for (const submesh of mesh.submeshes) {
        const instance = this.usedRecords++;
        const base = instance * RECORD_FLOATS;
        for (let i = 0; i < 16; i++) f[base + i] = matrix[i]!;
        const ground = item.groundPlane;
        f.set([ground.surfacePosition[0], ground.surfacePosition[1], ground.surfacePosition[2], 0, ground.up[0], ground.up[1], ground.up[2], 0], base + 16);
        f.set(submesh.baseColor, base + 24);
        records.push(instance);
      }
    }
    return records;
  }

  /** Room for every record the frame can write: one a submesh for the world pass, and one a submesh for each window's casters. */
  private reserveRecords(): void {
    const submeshes = (items: readonly DrawItem[]) => items.reduce((sum, item) => sum + item.mesh.meshes.reduce((s, mesh) => s + mesh.submeshes.length, 0), 0);
    const needed = submeshes(this.drawItems) + 2 * submeshes(this.casterItems);
    const capacity = this.records.length / RECORD_FLOATS;
    if (needed <= capacity) return;
    let records = capacity;
    while (records < needed) records *= 2;
    this.records = new Float32Array(records * RECORD_FLOATS);
    this.retiredBuffers.push(this.recordBuffer);
    this.recordBuffer = this.makeRecordBuffer(records);
    this.recordGroup = this.makeRecordGroup();
  }

  private makeRecordBuffer(records: number): GPUBuffer {
    return this.device.createBuffer({ label: "scene model draws", size: records * SCENE_MODEL_DRAW_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private makeRecordGroup(): GPUBindGroup {
    return this.device.createBindGroup({ label: "scene model draws", layout: this.pipelines.sceneModelDrawLayout, entries: [{ binding: 0, resource: { buffer: this.recordBuffer } }] });
  }
}
