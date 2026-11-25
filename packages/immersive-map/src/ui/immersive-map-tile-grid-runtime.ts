// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraFrameState } from "../camera/frame-camera-state-resolver.ts";
import type { TileGridSettings } from "../configuration/tile-grid-settings.ts";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { labelAtlasAssets, loadLabelAtlasTexture } from "../labels/drawers/label-gpu.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import type { SelectionPickData } from "../selection/selectable-map-feature.ts";
import type { ImmersiveMapTileGridController } from "../tile-grid/immersive-map-tile-grid-controller.ts";
import { TileGridSelection, type TileGridSelectionSource } from "../tile-grid/selection/tile-grid-selection.ts";
import type { TileGridAtlas } from "../tile-grid/tile-grid-atlas.ts";
import { TileGridPipeline, type TileGridPipelineContext } from "../tile-grid/tile-grid-pipeline.ts";
import { type TileGridRenderFrame, TileGridRenderSubsystem } from "../tile-grid/tile-grid-render-subsystem.ts";

export interface ImmersiveMapTileGridRuntimeOptions {
  /** The app's controller, null for a map that shows no grid. */
  readonly controller: ImmersiveMapTileGridController | null;
  readonly pipeline: TileGridPipelineContext;
  /** The bold label atlas's glyphs, `undefined` when the map could not read them: the grid then shows its borders alone. */
  readonly atlas: TileGridAtlas | undefined;
  /** The bold label atlas as the labels hold it, `undefined` on a map whose labels are off: the grid then loads its own. */
  readonly labelAtlasTexture: () => GPUTexture | undefined;
  readonly settings: () => TileGridSettings;
  /** What the grid reads of the frame being drawn. */
  readonly frame: () => TileGridRenderFrame | undefined;
  /** Asks the map for a frame. */
  readonly requestFrame: () => void;
}

/**
 * The map's side of the tile grid, the Swift `ImmersiveMapTileGridRuntime`:
 * holds the grid's controller attached to one map, asks for a frame when
 * the app or a tap changes the grid, and hands the controller's side of it
 * to the frame (`TileGridRenderSubsystem`) and to the tap
 * (`TileGridSelection`).
 */
export class ImmersiveMapTileGridRuntime implements TileGridSelectionSource {
  readonly subsystem: TileGridRenderSubsystem;
  readonly selection: TileGridSelection;
  private readonly pipeline: TileGridPipeline;
  private controller: ImmersiveMapTileGridController | null = null;
  private ownAtlasTexture: GPUTexture | undefined;
  private loadingAtlas = false;
  private destroyed = false;

  constructor(private readonly options: ImmersiveMapTileGridRuntimeOptions) {
    this.pipeline = new TileGridPipeline(options.pipeline);
    this.subsystem = new TileGridRenderSubsystem(
      this.pipeline,
      options.atlas,
      () => this.controller,
      options.settings,
      options.frame,
      () => this.provideAtlas(),
      options.requestFrame,
    );
    this.selection = new TileGridSelection(this);
    // The map's first frame draws the grid: nothing is asked of a map still being built.
    this.controller = options.controller;
    options.controller?.setChangeHandler(options.requestFrame, this);
  }

  get tileGridController(): ImmersiveMapTileGridController | null {
    return this.controller;
  }

  /** Attaches the app's controller, null for none: attached or detached, the grid appears or goes. */
  attach(next: ImmersiveMapTileGridController | null): void {
    if (this.controller === next) return;
    this.controller?.clearChangeHandler(this);
    this.controller = next;
    next?.setChangeHandler(this.options.requestFrame, this);
    if (next === null) this.selection.resetPickData();
    this.options.requestFrame();
  }

  /** What a tap can land on, of the last frame drawn. */
  pickData(): SelectionPickData | null {
    return this.subsystem.pickData;
  }

  /** Lets go of the map's side: the pipelines, the buffers and the controller's binding. */
  destroy(): void {
    this.destroyed = true;
    this.controller?.clearChangeHandler(this);
    this.controller = null;
    this.subsystem.destroy();
    this.ownAtlasTexture?.destroy();
  }

  /** The texts' font, the first time a text is to be drawn: the labels' own atlas, or one loaded for the grid on a map without labels. */
  private provideAtlas(): void {
    const atlas = this.options.atlas;
    if (atlas === undefined || this.pipeline.hasAtlas) return;
    const shared = this.options.labelAtlasTexture();
    if (shared !== undefined) {
      this.pipeline.setAtlas(shared, atlas);
      return;
    }
    if (this.loadingAtlas) return;
    this.loadingAtlas = true;
    loadLabelAtlasTexture(this.options.pipeline.device, labelAtlasAssets.bold, "tile grid atlas")
      .then((texture) => {
        if (this.destroyed) {
          texture.destroy();
          return;
        }
        this.ownAtlasTexture = texture;
        this.pipeline.setAtlas(texture, atlas);
        this.options.requestFrame();
      })
      .catch((error: unknown) => {
        console.error(`ImmersiveMap could not load the tile grid's font: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}

/** What the grid reads of a frame, from what the map computed for it. */
export function tileGridFrameOf(presentation: ResolvedPresentationState, cameraFrame: CameraFrameState): TileGridRenderFrame {
  const projectionView = cameraFrame.cameraMatrices.projectionView;
  // The render world is normalized to the camera's integer zoom, so the map's size over that zoom's tile count is one such tile.
  const normalization = presentation.renderNormalizationState;
  return {
    renderSurfaceMode: presentation.renderSurfaceMode,
    projectionView,
    cameraEye: cameraFrame.cameraEye,
    flatRenderState: presentation.flatRenderState,
    globe: presentation.globeRenderState.globeUniform,
    centerWorldMercator: cameraFrame.mapCameraState.centerWorldMercator,
    cameraZoom: cameraFrame.mapCameraState.zoom,
    tileWorldSize: normalization.flatRenderMapSize / normalization.zoomScale,
    // Copies: the camera's matrices are written again by the next frame, and a tap reads this one's.
    pickProjection: () =>
      new GeoScreenProjectionFrameConstants(cameraFrame.drawWidth, cameraFrame.drawHeight, { matrix: new Float64Array(projectionView), eye: [...cameraFrame.cameraEye] }, presentation),
  };
}
