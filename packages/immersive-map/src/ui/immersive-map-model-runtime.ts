// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The map's side of the 3D models, the Swift `ImmersiveMapSceneModelRuntime`
 * and the model archive's part of the renderer graph: the app's scene models
 * (the controller attached to one map, their mesh store, their subsystem and
 * their selection) and the models of the model archive (the model tile
 * worker, the store, the uploader and their subsystem), with the frame's
 * model state both write and the buildings read (`SceneModelFrameState`).
 *
 * The two subsystems are registered before the buildings', so the frame's
 * replaced buildings and the model tiles still on their way are known when
 * the buildings update.
 */

import { modelDepthBias } from "../configuration/model-archive-settings.ts";
import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { GpuContext } from "../render/core/gpu-context.ts";
import { SceneModelFrameState } from "../render/core/scene-model-frame-state.ts";
import type { FrameEngine } from "../render/frame-engine.ts";
import type { ImmersiveMapSceneModelTapEvent } from "../scene-models/immersive-map-scene-model-tap-event.ts";
import type { ResolvedSceneModelSource } from "../scene-models/immersive-map-scene-model.ts";
import { ImmersiveMapSceneModelsController } from "../scene-models/immersive-map-scene-models-controller.ts";
import { ModelTileMesh, ModelTileUploader } from "../scene-models/model-tiles/model-tile-mesh.ts";
import { type ModelTileFrameInput, ModelTileRenderSubsystem } from "../scene-models/model-tiles/model-tile-render-subsystem.ts";
import { ModelTileSource } from "../scene-models/model-tiles/model-tile-source.ts";
import { ModelTileStore } from "../scene-models/model-tiles/model-tile-store.ts";
import { ModelTileTriangleCuller } from "../scene-models/model-tiles/model-tile-triangle-culler.ts";
import { ModelPipelines } from "../scene-models/pipelines/model-pipelines.ts";
import { SceneModelGpuMesh, SceneModelGpuMeshFactory } from "../scene-models/scene-model-gpu-mesh.ts";
import { SceneModelMeshStore } from "../scene-models/scene-model-mesh-store.ts";
import { type SceneModelFrameInput, SceneModelRenderSubsystem } from "../scene-models/scene-model-render-subsystem.ts";
import { SceneModelSelection } from "../scene-models/selection/scene-model-selection.ts";
import type { SelectionPickData } from "../selection/selectable-map-feature.ts";
import type { StandingPipelines } from "../tile/pipelines/standing-pipelines.ts";
import type { TilePipelineContext } from "../tile/pipelines/tile-pipeline.ts";
import type { StandingFrame } from "../tile/subsystems/standing-frame.ts";

export interface ImmersiveMapModelRuntimeOptions {
  readonly gpu: GpuContext;
  readonly pipeline: TilePipelineContext;
  readonly standingPipelines: StandingPipelines;
  readonly standingFrame: StandingFrame;
  readonly settings: () => ImmersiveMapSettings;
  /** The app's controller, a new one when left out. */
  readonly controller: ImmersiveMapSceneModelsController | undefined;
  readonly sceneModelFrame: () => SceneModelFrameInput;
  readonly modelTileFrame: () => ModelTileFrameInput;
  /** Asks the map for a frame: a mesh or a tile landed, a retry is due, the app changed its models. */
  readonly requestFrame: () => void;
  /** The app's models changed: a selected model that is gone is let go. */
  readonly syncSelection: () => void;
}

export class ImmersiveMapModelRuntime {
  /** The app's scene models (`ImmersiveMap.sceneModels`). */
  readonly controller: ImmersiveMapSceneModelsController;
  /** The frame's model state: the scene models start it over, the model tiles add to it, the buildings read it. */
  readonly state = new SceneModelFrameState();
  readonly sceneModels: SceneModelRenderSubsystem;
  readonly modelTiles: ModelTileRenderSubsystem;
  readonly selection: SceneModelSelection;
  private readonly tapListeners = new Set<(event: ImmersiveMapSceneModelTapEvent) => void>();
  private readonly meshFactory: SceneModelGpuMeshFactory;

  constructor(private readonly options: ImmersiveMapModelRuntimeOptions) {
    const { gpu } = options;
    const { device } = gpu;
    const pipelines = new ModelPipelines(options.pipeline, options.standingPipelines, gpu.capabilities.clipDistances);
    // Built off the frame: the first model that loads finds them made.
    void pipelines.prewarm();
    this.controller = options.controller ?? new ImmersiveMapSceneModelsController();
    this.controller.setChangeHandler(() => {
      options.requestFrame();
      options.syncSelection();
    }, this);
    this.controller.markSnapshotDirty();
    this.meshFactory = new SceneModelGpuMeshFactory(device, pipelines);
    const factory = this.meshFactory;
    const meshes = new SceneModelMeshStore<ResolvedSceneModelSource, SceneModelGpuMesh>({ load: (source) => factory.load(source), invalidate: options.requestFrame });
    this.sceneModels = new SceneModelRenderSubsystem(device, pipelines, options.standingFrame, meshes, () => this.controller, options.sceneModelFrame, this.state, document.baseURI);
    const controller = this.controller;
    this.selection = new SceneModelSelection({ model: (id) => controller.model(id) });
    this.selection.tapAction = (event) => {
      for (const listener of this.tapListeners) listener(event);
    };

    // The model archive: none for a map without one (`modelArchive(null)`).
    const archive = options.settings().data.modelArchive;
    let store: ModelTileStore<ModelTileMesh> | undefined;
    let uploader: ModelTileUploader | undefined;
    if (archive.archiveURL !== null) {
      const source = new ModelTileSource({
        archiveURL: new URL(archive.archiveURL, location.href).href,
        requestHeaders: { ...archive.requestHeaders },
        diskCacheSizeInBytes: options.settings().tiles.cache.preparedTileCacheEnabled ? archive.diskCacheSizeInBytes : 0,
        clearsDiskCache: options.settings().tiles.cache.clearDiskCachesOnLaunch,
        // Decision B14: the archive's ASTC blocks where the GPU samples them, RGBA8 decoded in the worker elsewhere.
        textureMode: gpu.capabilities.textureCompressionASTC ? "astc" : "rgba8",
      });
      const tileUploader = new ModelTileUploader(device, pipelines.modelTileTextureLayout, pipelines.modelTileSampler, options.requestFrame);
      uploader = tileUploader;
      store = new ModelTileStore<ModelTileMesh>({
        costLimitBytes: archive.memoryBudgetInBytes,
        invalidate: options.requestFrame,
        load: async (tile) => {
          const answer = await source.load(tile);
          if (answer.kind === "missing") return answer;
          return { kind: "mesh", mesh: await tileUploader.upload(answer.tile) };
        },
      });
      this.destroySource = () => source.destroy();
    }
    this.modelTiles = new ModelTileRenderSubsystem(
      pipelines,
      options.standingFrame,
      store,
      uploader,
      () => {
        const settings = options.settings();
        const modelArchive = settings.data.modelArchive;
        return { minimumZoom: modelArchive.minimumZoom, riseSeconds: settings.scene.extrusion.riseSeconds, depthBias: (zoom) => modelDepthBias(modelArchive, zoom) };
      },
      options.modelTileFrame,
      this.state,
      // The culled draws name their record as the indirect draw's first instance, and the culling ranks by subgroup ballots.
      store !== undefined && gpu.capabilities.indirectFirstInstance && gpu.capabilities.subgroups ? new ModelTileTriangleCuller(device, options.standingFrame.cameraBuffer) : undefined,
      options.pipeline.sampleCount,
    );
  }

  private destroySource: () => void = () => undefined;

  /** Registers the subsystems: call before the buildings' are registered. */
  register(engine: FrameEngine): void {
    engine.register(this.sceneModels);
    engine.register(this.modelTiles);
    engine.registerFlush(() => this.sceneModels.flush());
  }

  /** Every tap on a scene model (`ImmersiveMapSceneModelTapEvent`). Returns the function that stops the listening. */
  onSceneModelTap(listener: (event: ImmersiveMapSceneModelTapEvent) => void): () => void {
    this.tapListeners.add(listener);
    return () => this.tapListeners.delete(listener);
  }

  /** What the scene models drew in the last frame, for the selection. */
  pickData(): SelectionPickData | null {
    return this.sceneModels.selectionSnapshot;
  }

  /** After the frame: the flights that ended tell the controller where they stopped, and their completions fire. */
  frameDrawn(): void {
    const results = this.sceneModels.consumePathAnimationResults();
    if (results.length > 0) this.controller.applyPathAnimationResults(results);
  }

  /** The models still on their way: the app's meshes and the archive's tiles (a capture waits for both). */
  get pendingCount(): number {
    return this.sceneModels.pendingCount + this.modelTiles.pendingCount;
  }

  /** A model moving, a tile rising or being written: the frames keep coming. */
  get isAnimating(): boolean {
    return this.sceneModels.hasActiveAnimations || this.modelTiles.isActive;
  }

  destroy(): void {
    this.controller.clearChangeHandler(this);
    this.tapListeners.clear();
    this.sceneModels.destroy();
    this.modelTiles.destroy();
    this.destroySource();
    this.meshFactory.destroy();
  }
}
