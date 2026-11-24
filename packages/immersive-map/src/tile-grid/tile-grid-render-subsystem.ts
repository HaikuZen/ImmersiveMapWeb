// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TileGridSettings } from "../configuration/tile-grid-settings.ts";
import type { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { GlobeSphereVertexPath } from "../globe/globe-frame-constants.ts";
import type { RenderLayer, RenderPassAvailability } from "../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import type { ImmersiveMapTileGridController } from "./immersive-map-tile-grid-controller.ts";
import { TileGridSelectionSnapshot } from "./selection/tile-grid-selection-snapshot.ts";
import type { TileGridAtlas } from "./tile-grid-atlas.ts";
import { TileGridFrame, type TileGridFrameInput } from "./tile-grid-frame.ts";
import { TileGridFrameLayout, type TileGridPipeline, type TileGridSurface, writeTileGridFrameUniform } from "./tile-grid-pipeline.ts";

/** What the grid reads of the frame being drawn, with the projection a tap is tested by. */
export interface TileGridRenderFrame extends TileGridFrameInput {
  /** The frame's projection for a tap's test, made only when the grid's tiles are for tapping. */
  readonly pickProjection: () => GeoScreenProjectionFrameConstants;
}

/**
 * Draws the tile grid on the ground of whichever surface the frame shows,
 * in a render layer of its own in the overlay pass (`tileGrid`), the Swift
 * `TileGridRenderSubsystem`: over the whole world, the buildings and the
 * map's names included, so nothing the map draws covers a border or a
 * tile's numbers, and under the pins. A frame with no controller attached,
 * or whose tiles are too small on screen, leaves the render layer out.
 *
 * A frame works out its grid anew from the camera, the settings and the
 * controller (`TileGridFrame`), and keeps nothing between frames but the
 * texts it laid out. A frame that reads the same as the one before gives
 * the GPU nothing: the buffers stand as they were. The grid lies on the
 * plane and does not rise with the ground relief, as the layers of the
 * app's data do not. It is unlit and takes no fog, so it reads the same by
 * day and on the night side.
 */
export class TileGridRenderSubsystem implements RenderSubsystem {
  readonly name = "TileGrid";
  readonly layers: readonly RenderLayer[] = ["tileGrid"];

  private readonly gridFrame: TileGridFrame;
  private readonly uniformStaging = new Float32Array(TileGridFrameLayout.byteLength / 4);
  private snapshot = TileGridSelectionSnapshot.empty;
  private surface: TileGridSurface = "flat";
  private draws = false;
  private drawsHalo = false;
  /** What the uniform was last written from. */
  private uniformKey: { settings: TileGridSettings; drawWidth: number; drawHeight: number; pixelsPerPoint: number; hasAtlas: boolean } | undefined;
  /** The tiles and the draws of the last frame. */
  drawnTileCount = 0;
  drawCount = 0;

  constructor(
    private readonly pipeline: TileGridPipeline,
    private readonly atlas: TileGridAtlas | undefined,
    /** The attached controller, null when the map shows no grid. */
    private readonly controller: () => ImmersiveMapTileGridController | null,
    private readonly settings: () => TileGridSettings,
    private readonly frame: () => TileGridRenderFrame | undefined,
    /** The texts' font is wanted: the map hands it to the pipeline when it has it. */
    private readonly wantAtlas: () => void,
    /** A frame is wanted: the pipelines were compiled. */
    private readonly onReady: () => void,
  ) {
    this.gridFrame = new TileGridFrame(atlas);
  }

  /** What a tap can land on, of the last frame, null for a frame with no controller attached. */
  get pickData(): TileGridSelectionSnapshot | null {
    return this.controller() === null ? null : this.snapshot;
  }

  update(context: FrameContext): void {
    this.draws = false;
    this.drawnTileCount = 0;
    this.drawCount = 0;
    const controller = this.controller();
    const frame = this.frame();
    // No controller, no grid: nothing is drawn and nothing is told to the tap, which then never asks.
    if (controller === null || frame === undefined) {
      this.snapshot = TileGridSelectionSnapshot.empty;
      return;
    }
    const settings = this.settings();
    const grid = this.gridFrame;
    const pixelsPerPoint = Math.max(context.pixelsPerPoint, 1e-6);
    const changed = grid.resolve(frame, settings, controller, context.drawHeight / Math.max(context.pixelsPerPoint, 1));

    // What a tap can land on: the tiles of the zoom this frame shows, by
    // the projection it draws them with. A snapshot without a projection
    // too: a grid that stops being shown stops being tappable.
    const takesTaps = grid.zoom !== undefined && settings.isTapSelectionEnabled;
    this.snapshot = new TileGridSelectionSnapshot(
      context.frameNumber,
      context.drawWidth,
      context.drawHeight,
      takesTaps ? frame.pickProjection() : undefined,
      grid.zoom ?? 0,
      settings.selectionGesture,
      settings.selectionMode,
      settings.selectionLimit,
      settings.selectableBounds,
    );
    if (grid.tileCount === 0) return;
    this.drawnTileCount = grid.tileCount;

    const pipeline = this.pipeline;
    if (!pipeline.isReady) pipeline.prepare(this.onReady);
    if (grid.glyphCount > 0 && !pipeline.hasAtlas) this.wantAtlas();
    if (changed) {
      pipeline.writeTiles(grid.instanceBytes());
      pipeline.writeGlyphs(grid.glyphBytes());
    }
    const key = this.uniformKey;
    if (key === undefined || key.settings !== settings || key.drawWidth !== context.drawWidth || key.drawHeight !== context.drawHeight || key.pixelsPerPoint !== pixelsPerPoint || key.hasAtlas !== pipeline.hasAtlas) {
      this.uniformKey = { settings, drawWidth: context.drawWidth, drawHeight: context.drawHeight, pixelsPerPoint, hasAtlas: pipeline.hasAtlas };
      writeTileGridFrameUniform(this.uniformStaging, settings, context.drawWidth, context.drawHeight, pixelsPerPoint, this.atlas);
      pipeline.writeFrameUniform(this.uniformStaging);
    }
    this.surface = frame.renderSurfaceMode === "flat" ? "flat" : GlobeSphereVertexPath.isPureSphere(frame.renderSurfaceMode, frame.globe.transition) ? "sphere" : "morph";
    this.drawsHalo = settings.labelHaloWidthPoints > 0;
    this.draws = true;
  }

  contributeAvailability(availability: RenderPassAvailability): void {
    availability.tileGridEnabled = availability.tileGridEnabled || (this.draws && this.pipeline.isReady);
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    if (layer !== "tileGrid" || !this.draws) return;
    const grid = this.gridFrame;
    this.drawCount = this.pipeline.draw(pass, {
      surface: this.surface,
      plainCount: grid.plainCount,
      selectedCount: grid.selectedCount,
      otherCount: grid.otherCount,
      gridSubdivision: grid.gridSubdivision,
      otherSubdivision: grid.otherSubdivision,
      glyphCount: grid.glyphCount,
      drawsHalo: this.drawsHalo,
    });
  }

  destroy(): void {
    this.gridFrame.destroy();
    this.pipeline.destroy();
    this.snapshot = TileGridSelectionSnapshot.empty;
  }
}
