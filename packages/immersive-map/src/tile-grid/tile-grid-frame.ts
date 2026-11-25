// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../camera/view-mode.ts";
import type { TileGridLabelFormat, TileGridSettings } from "../configuration/tile-grid-settings.ts";
import { frameWasmMemory } from "../frame/frame-wasm.ts";
import type { ImmersiveMapTileID } from "../geo/immersive-map-tile-id.ts";
import type { GlobeUniform } from "../globe/globe-uniform.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import type { FlatRenderState } from "../presentation/resolved-presentation-state.ts";
import { TileGrid as WasmTileGrid } from "../wasm/frame_wasm/frame_wasm.js";
import type { ImmersiveMapTileGridController, ImmersiveMapTileGridLabelProvider } from "./immersive-map-tile-grid-controller.ts";
import { layOutTileGridText, type TileGridAtlas } from "./tile-grid-atlas.ts";

/** What the grid reads of the frame being drawn. */
export interface TileGridFrameInput {
  readonly renderSurfaceMode: ViewMode;
  /** The CPU projection-view matrix (column-major), what the map's own coverage is resolved by. */
  readonly projectionView: Mat4;
  readonly cameraEye: Vec3;
  readonly flatRenderState: FlatRenderState;
  readonly globe: GlobeUniform;
  /** The point the camera looks at, in the normalized world Mercator. */
  readonly centerWorldMercator: Vec2;
  /** The camera's own zoom, not the one the map is planned by: the grid's threshold is about what is on screen. */
  readonly cameraZoom: number;
  /** The size in the flat render world of a tile of the camera's integer zoom. */
  readonly tileWorldSize: number;
}

/** Bytes a tile of the frame takes on the GPU (`TileGridTile` in tile-grid.wgsl). */
export const TILE_GRID_TILE_BYTES = 32;
/** Bytes a glyph of the frame takes on the GPU (`TileGridGlyphIn` in tile-grid.wgsl). */
export const TILE_GRID_GLYPH_BYTES = 16;

/** The layouts and the texts kept at most, each: past it they are let go and made again as the frames ask. */
const cacheLimit = 4096;
const noLabel = -1;

/** The header the module leaves (crates/frame-wasm/src/tile_grid.rs). */
const headerWords = 16;

/** Bytes of the module's memory, valid until its next call. */
export interface WasmBytes {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/**
 * The grid of frame after frame, the Swift `TileGridRenderSubsystem.update`
 * and `TileGridLabels`: the zoom whose tiles show, those tiles in view, the
 * nearest first, the selected among them, the selected tiles of every other
 * zoom in view, and the glyphs of the tiles' texts. All of it is worked out
 * by the Rust of ImmersiveMapCore in one call a frame
 * (2.7 to 3.6 times faster than the same in TypeScript), from the selection and the texts
 * copied into the module when they change, and left in the module's memory
 * as the GPU takes it. This side answers what the module asks: the texts of
 * the tiles it has not seen, which the app's provider or the settings'
 * format give, laid out once each.
 */
export class TileGridFrame {
  private readonly grid = new WasmTileGrid();
  private readonly headerPtr: number;
  private boundSettings: TileGridSettings | undefined;
  private boundController: ImmersiveMapTileGridController | undefined;
  private selectionRevision = -1;
  private labelKey: { format: TileGridLabelFormat; revision: number; controller: ImmersiveMapTileGridController } | undefined;
  private readonly layouts = new Map<string, number>();
  private readonly matrix = new Float64Array(16);

  /** The zoom the grid shows, `undefined` for a frame with no grid. */
  zoom: number | undefined;
  drawsLabels = false;
  /** The grid's tiles that are not selected: the first run of the tiles. */
  plainCount = 0;
  /** The grid's selected tiles: the run after them. */
  selectedCount = 0;
  /** The selected tiles of other zooms, drawn as their fill alone: the last run. */
  otherCount = 0;
  /** How finely the tiles of the grid, and those of the last run, are divided, in quads a side. */
  gridSubdivision = 1;
  otherSubdivision = 1;
  glyphCount = 0;
  private instancesPtr = 0;
  private tilesPtr = 0;
  private glyphsPtr = 0;

  constructor(private readonly atlas: TileGridAtlas | undefined) {
    this.headerPtr = this.grid.headerPtr;
  }

  get tileCount(): number {
    return this.plainCount + this.selectedCount + this.otherCount;
  }

  /**
   * The frame's grid. False when nothing it is made of has changed since the
   * frame before: what the GPU was given then still stands.
   */
  resolve(input: TileGridFrameInput, settings: TileGridSettings, controller: ImmersiveMapTileGridController, viewportHeightPoints: number): boolean {
    const grid = this.grid;
    if (settings !== this.boundSettings) {
      this.boundSettings = settings;
      grid.setSettings(
        settings.zoomRange[0],
        settings.zoomRange[1],
        settings.minimumTileScreenPoints,
        settings.labelMinimumTileScreenPoints,
        settings.maximumDrawnTiles,
        settings.labelMaximumWidthShare,
        settings.labelMaximumHeightShare,
      );
    }
    if (controller !== this.boundController || controller.selectionRevision !== this.selectionRevision) {
      this.boundController = controller;
      this.selectionRevision = controller.selectionRevision;
      grid.setSelection(controller.selectionTriples());
    }
    this.syncLabels(settings.labelFormat, controller);

    const onGlobe = input.renderSurfaceMode !== "flat";
    const { flatRenderState: flat, globe, cameraEye: eye, centerWorldMercator: centre } = input;
    this.matrix.set(input.projectionView);
    const changed = grid.resolve(
      this.matrix,
      onGlobe,
      flat.pan[0],
      flat.pan[1],
      flat.renderMapSize,
      eye[0],
      eye[1],
      eye[2],
      globe.panX,
      globe.panY,
      globe.radius,
      globe.transition,
      centre[0],
      centre[1],
      input.cameraZoom,
      viewportHeightPoints,
      input.tileWorldSize,
    );
    if (!changed) return false;
    let header = this.readHeader();
    const missCount = header[8]!;
    if (missCount > 0) {
      this.answer(new Int32Array(frameWasmMemory().buffer, header[12]!, missCount * 3), settings.labelFormat, controller.labelProvider);
      grid.layOutLabels();
      header = this.readHeader();
    }
    return true;
  }

  /** The frame's tiles as the GPU takes them, `TILE_GRID_TILE_BYTES` each. */
  instanceBytes(): WasmBytes {
    return { buffer: frameWasmMemory().buffer, byteOffset: this.instancesPtr, byteLength: this.tileCount * TILE_GRID_TILE_BYTES };
  }

  /** The frame's glyphs as the GPU takes them, `TILE_GRID_GLYPH_BYTES` each. */
  glyphBytes(): WasmBytes {
    return { buffer: frameWasmMemory().buffer, byteOffset: this.glyphsPtr, byteLength: this.glyphCount * TILE_GRID_GLYPH_BYTES };
  }

  /** The frame's tiles by their numbers, in the order they are drawn: zoom, x, y and the copy of the world, four ints each. A view valid until the next call of the module. */
  tileNumbers(): Int32Array {
    return new Int32Array(frameWasmMemory().buffer, this.tilesPtr, this.tileCount * 4);
  }

  destroy(): void {
    this.grid.free();
  }

  private readHeader(): Uint32Array {
    const header = new Uint32Array(frameWasmMemory().buffer, this.headerPtr, headerWords);
    this.zoom = header[0] === 0 ? undefined : header[0]! - 1;
    this.drawsLabels = header[1] !== 0;
    this.plainCount = header[2]!;
    this.selectedCount = header[3]!;
    this.otherCount = header[4]!;
    this.gridSubdivision = header[5]!;
    this.otherSubdivision = header[6]!;
    this.glyphCount = header[7]!;
    this.instancesPtr = header[9]!;
    this.tilesPtr = header[10]!;
    this.glyphsPtr = header[11]!;
    return header;
  }

  /** The texts are kept until the format, the provider or what it answers changes, and until they are too many. */
  private syncLabels(format: TileGridLabelFormat, controller: ImmersiveMapTileGridController): void {
    const key = this.labelKey;
    const grid = this.grid;
    if (key === undefined || key.format !== format || key.revision !== controller.labelRevision || key.controller !== controller || grid.tileLabelCount > cacheLimit) {
      this.labelKey = { format, revision: controller.labelRevision, controller };
      grid.clearTileLabels();
    }
    if (this.layouts.size > cacheLimit) {
      this.layouts.clear();
      grid.clearLayouts();
    }
  }

  /** Tells the module the text of each tile it asked for: three ints a tile in, four out, the last the text's handle. */
  private answer(misses: Int32Array, format: TileGridLabelFormat, provider: ImmersiveMapTileGridLabelProvider | null): void {
    // The module's memory may move while a text is laid out: the tiles are read first.
    const tiles = misses.slice();
    const labels = new Int32Array((tiles.length / 3) * 4);
    for (let i = 0, o = 0; i < tiles.length; i += 3, o += 4) {
      const tile = { zoom: tiles[i]!, x: tiles[i + 1]!, y: tiles[i + 2]! };
      labels[o] = tile.zoom;
      labels[o + 1] = tile.x;
      labels[o + 2] = tile.y;
      labels[o + 3] = this.layout(TileGridFrame.text(tile, format, provider));
    }
    this.grid.setTileLabels(labels);
  }

  /** The handle of a text's layout, laid out the first time it is asked. */
  private layout(text: string | undefined): number {
    if (text === undefined || this.atlas === undefined) return noLabel;
    let handle = this.layouts.get(text);
    if (handle === undefined) {
      const layout = layOutTileGridText(this.atlas, text);
      handle = layout === undefined ? noLabel : this.grid.defineLayout(layout.widthEm, layout.heightEm, layout.records);
      this.layouts.set(text, handle);
    }
    return handle;
  }

  /**
   * What is written inside a tile: the app's own text when it gives a
   * provider, the tile's numbers in the settings' format otherwise,
   * `undefined` for no text.
   */
  static text(tile: ImmersiveMapTileID, format: TileGridLabelFormat, provider: ImmersiveMapTileGridLabelProvider | null): string | undefined {
    if (provider !== null) {
      const text = provider(tile);
      return typeof text === "string" && text.length > 0 ? text : undefined;
    }
    if (format === "zxy") return `${tile.zoom}/${tile.x}/${tile.y}`;
    if (format === "xyz") return `${tile.x}/${tile.y}/${tile.zoom}`;
    return undefined;
  }
}
