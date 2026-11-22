// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraFrameState } from "../camera/frame-camera-state-resolver.ts";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import type { ImmersiveMapLayer } from "../layers/immersive-map-layer.ts";
import type { ImmersiveMapLayerTapEvent } from "../layers/immersive-map-layer-tap-event.ts";
import { ImmersiveMapLayersController } from "../layers/immersive-map-layers-controller.ts";
import { gpuLayerMesh, LayerMeshStore } from "../layers/layer-mesh-store.ts";
import { LayerPipeline, type LayerPipelineContext } from "../layers/layer-pipeline.ts";
import { ControllerLayerRenderSource, FixedLayerRenderSource, type LayerRenderSource } from "../layers/layer-render-source.ts";
import { type LayerFrame, LayerRenderSubsystem } from "../layers/layer-render-subsystem.ts";
import { LayerSelection, type LayerSelectionSource } from "../layers/selection/layer-selection.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import type { SelectionPickData } from "../selection/selectable-map-feature.ts";

export interface ImmersiveMapLayerRuntimeOptions {
  /** The app's controller, a new one when left out. */
  readonly controller: ImmersiveMapLayersController | undefined;
  readonly pipeline: LayerPipelineContext;
  /** What the layers read of the frame being drawn. */
  readonly frame: () => LayerFrame | undefined;
  /** Whether the map holds a selection controller: a tap then selects a shape, so the shapes are kept. */
  readonly hasSelectionController: () => boolean;
  /** Asks the map for a frame. */
  readonly requestFrame: () => void;
  /** The layers changed: a selected shape whose layer is gone is let go. */
  readonly syncSelection: () => void;
  /**
   * Draw the controller's layers as they are now and never bind to it
   * (`FixedLayerRenderSource`): an export's map, which must not take the
   * live map's binding or follow later changes.
   */
  readonly fixedLayers?: boolean;
}

/**
 * The map's side of the layers of the app's data, the Swift
 * `ImmersiveMapLayerRuntime`: attaches the app's controller to one map, asks
 * for a frame when the app changes its layers or a layer lands, feeds the
 * layers to the frame (`LayerRenderSubsystem`) and to the selection
 * (`LayerSelection`), and keeps the shapes of the drawn layers at hand while
 * the app listens to taps on them or holds a selection controller.
 */
export class ImmersiveMapLayerRuntime implements LayerSelectionSource {
  readonly controller: ImmersiveMapLayersController;
  readonly subsystem: LayerRenderSubsystem;
  readonly selection: LayerSelection;
  private readonly tapListeners = new Set<(event: ImmersiveMapLayerTapEvent) => void>();

  constructor(private readonly options: ImmersiveMapLayerRuntimeOptions) {
    const controller = options.controller ?? new ImmersiveMapLayersController();
    this.controller = controller;
    const { device } = options.pipeline;
    const store = new LayerMeshStore((key, file) => gpuLayerMesh(device, key, file), options.requestFrame);
    const source: LayerRenderSource = options.fixedLayers === true ? new FixedLayerRenderSource(controller) : new ControllerLayerRenderSource(controller);
    this.subsystem = new LayerRenderSubsystem(
      new LayerPipeline(options.pipeline),
      store,
      () => {
        // The shapes of the drawn layers are kept for a tap while one can land on them.
        controller.library.shapesWanted = this.picksWanted();
        return source;
      },
      options.frame,
      () => this.picksWanted(),
      options.requestFrame,
    );
    this.selection = new LayerSelection(this);
    this.selection.tapAction = (event) => {
      for (const listener of this.tapListeners) listener(event);
    };
    // The app changes its layers whenever it likes: a frame is asked for, and
    // the selection lets go of a shape whose layer is gone. Fixed layers
    // follow no change.
    if (options.fixedLayers !== true) {
      controller.setChangeHandler(() => {
        options.requestFrame();
        options.syncSelection();
      }, this);
    }
  }

  /** What a tap can land on, of the last frame drawn. */
  pickData(): SelectionPickData | null {
    return this.subsystem.pickData;
  }

  layer(id: string): ImmersiveMapLayer | undefined {
    return this.controller.layer(id);
  }

  /** Every tap on a shape the map shows. Returns the function that stops the listening. */
  onLayerTap(listener: (event: ImmersiveMapLayerTapEvent) => void): () => void {
    this.tapListeners.add(listener);
    this.options.requestFrame();
    return () => {
      this.tapListeners.delete(listener);
    };
  }

  /** Lets go of the map's side: the meshes, the pipelines, the controller's binding, and the layers' worker when no other map draws the controller. */
  destroy(): void {
    this.tapListeners.clear();
    this.controller.clearChangeHandler(this);
    this.subsystem.destroy();
    const library = this.controller.library;
    if (!library.hasClients) {
      library.jobs.release();
      library.meshCache.close();
    }
  }

  private picksWanted(): boolean {
    return this.tapListeners.size > 0 || this.options.hasSelectionController();
  }
}

/** What the layers read of a frame, from what the map computed for it. */
export function layerFrameOf(presentation: ResolvedPresentationState, cameraFrame: CameraFrameState, reliefActive: boolean): LayerFrame {
  const projectionView = cameraFrame.cameraMatrices.projectionView;
  return {
    renderSurfaceMode: presentation.renderSurfaceMode,
    flatRenderState: presentation.flatRenderState,
    globe: presentation.globeRenderState.globeUniform,
    centerWorldX: cameraFrame.mapCameraState.centerWorldMercator[0],
    projectionView,
    reliefActive,
    // Copies: the camera's matrices are written again by the next frame, and a tap reads this one's.
    pickProjection: () =>
      new GeoScreenProjectionFrameConstants(cameraFrame.drawWidth, cameraFrame.drawHeight, { matrix: new Float64Array(projectionView), eye: [...cameraFrame.cameraEye] }, presentation),
  };
}
