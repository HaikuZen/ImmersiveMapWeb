// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapGeoBounds } from "../geo/immersive-map-geo-bounds.ts";
import { ImmersiveMapTileID } from "../geo/immersive-map-tile-id.ts";
import type { Rgba } from "./color.ts";
import { deepFreeze } from "./deep.ts";
import type { Options } from "./deep.ts";

/** What is written inside a tile: `zoom/x/y` (the order of a tile URL), `x/y/zoom`, or no text, the borders alone. */
export type TileGridLabelFormat = "zxy" | "xyz" | "hidden";

/**
 * The gesture that selects and deselects a tile.
 *
 * - `tap`: a tap, a click of the main button. The tile answers at once only
 *   with the double tap zoom off (`CameraSettings.isDoubleTapZoomEnabled`):
 *   with it on, a tap waits to learn that it is not a double tap.
 * - `doubleTap`: a double tap, a double click. While the grid takes it, the
 *   double tap does not zoom the map, whatever
 *   `CameraSettings.isDoubleTapZoomEnabled` says, and a single tap stays
 *   what it is for the pins and the rest of the map.
 * - `secondaryTap`: a click of the secondary (right) button, a long press
 *   on a touch screen. The other gestures keep their meaning: a tap for the
 *   pins, a double tap for the zoom, a drag of the secondary button for the
 *   tilt.
 */
export type TileGridSelectionGesture = "tap" | "doubleTap" | "secondaryTap";

/**
 * How many tiles the gesture may hold selected.
 *
 * - `multiple`: any number. The gesture adds a tile to the selection, or
 *   takes a selected one out of it.
 * - `single`: one. The gesture on another tile moves the selection to it,
 *   and on the selected tile takes the selection away. `selectionLimit` has
 *   nothing to limit.
 */
export type TileGridSelectionMode = "multiple" | "single";

/**
 * The tile grid: the borders of the XYZ tiles drawn over the map, the
 * buildings and the names included, with each tile's numbers written inside
 * it, for an app whose user picks tiles on the map, the Swift
 * `TileGridSettings`. The grid shows only while an
 * `ImmersiveMapTileGridController` is attached (`ImmersiveMap.tileGrid`),
 * and these settings say which tiles it shows, how it looks and what a tap
 * may select. Every one applies live.
 */
export interface TileGridSettings {
  /**
   * The zooms whose tiles the grid shows, the first and the last. The grid
   * shows the tiles of the camera's zoom, clamped into this range: `[12, 15]`
   * follows the camera between those zooms and stays at 12 above and at 15
   * below, and `[15, 15]` shows the zoom 15 tiles alone, whatever the
   * camera's zoom. Every zoom by default.
   */
  readonly zoomRange: readonly [number, number];
  /**
   * The grid hides while a tile is narrower on screen than this, in points,
   * so a deep zoom seen from far above is not a mesh of lines. Under a
   * tilted camera the far tiles fade by the same width. Lower it to see the
   * grid from farther, at the price of more tiles drawn. 48 by default.
   */
  readonly minimumTileScreenPoints: number;
  /** The texts hide while a tile is narrower on screen than this, in points: below it the numbers are too small to read. 96 by default. */
  readonly labelMinimumTileScreenPoints: number;
  /**
   * The most tiles the grid draws in a frame, those nearest to where the
   * camera looks first. It bounds the work of a frame under a camera tilted
   * to the horizon. 512 by default.
   */
  readonly maximumDrawnTiles: number;
  /** The color of the borders. */
  readonly lineColor: Rgba;
  /** The width of a border, in points, the same at every zoom. 1 by default. */
  readonly lineWidthPoints: number;
  /** The color of the text. */
  readonly labelColor: Rgba;
  /** The color of the outline round the text, which keeps it readable over any ground. */
  readonly labelHaloColor: Rgba;
  /** The width of the outline round the text, in points, 0 for none. 1.5 by default. */
  readonly labelHaloWidthPoints: number;
  /** The color laid over a selected tile. */
  readonly selectedFillColor: Rgba;
  /** What is written inside a tile. An `ImmersiveMapTileGridController.labelProvider` takes its place. `zxy` by default. */
  readonly labelFormat: TileGridLabelFormat;
  /** The widest the text may be, as a share of the tile's width. The text is sized to the tile, so it grows and shrinks with it. 0.7 by default. */
  readonly labelMaximumWidthShare: number;
  /** The tallest the text may be, as a share of the tile's height. 0.12 by default. */
  readonly labelMaximumHeightShare: number;
  /**
   * Whether the user can select and deselect tiles on the map, by
   * `selectionGesture`. Turn it off to show the grid and a selection made
   * from code without letting the user change it. On by default.
   */
  readonly isTapSelectionEnabled: boolean;
  /**
   * The gesture that selects and deselects a tile, a tap by default. Change
   * it when the tap or the double tap is wanted for something else, or to
   * keep a stray tap from changing the selection.
   */
  readonly selectionGesture: TileGridSelectionGesture;
  /** Whether the gesture may hold many tiles selected or one, many by default. A selection made from code is not held to it. */
  readonly selectionMode: TileGridSelectionMode;
  /**
   * The most tiles taps may select, null for no limit. A tap past the limit
   * selects nothing and is reported through
   * `ImmersiveMapTileGridController.onTapRejected`. A selection made from
   * code is not checked against it.
   */
  readonly selectionLimit: number | null;
  /**
   * The area a tap may select tiles in, null for the whole map: a tile is
   * selectable when it shares an area with the box. A selection made from
   * code is not checked against it.
   */
  readonly selectableBounds: ImmersiveMapGeoBounds | null;
}

export const defaultTileGridSettings: TileGridSettings = deepFreeze({
  zoomRange: [0, ImmersiveMapTileID.maximumZoom],
  minimumTileScreenPoints: 48,
  labelMinimumTileScreenPoints: 96,
  maximumDrawnTiles: 512,
  lineColor: [0.05, 0.07, 0.1, 0.75],
  lineWidthPoints: 1,
  labelColor: [0.05, 0.07, 0.1, 1],
  labelHaloColor: [1, 1, 1, 0.9],
  labelHaloWidthPoints: 1.5,
  selectedFillColor: [0.1, 0.45, 1, 0.35],
  labelFormat: "zxy",
  labelMaximumWidthShare: 0.7,
  labelMaximumHeightShare: 0.12,
  isTapSelectionEnabled: true,
  selectionGesture: "tap",
  selectionMode: "multiple",
  selectionLimit: null,
  selectableBounds: null,
});

const share = (value: number): number => Math.min(Math.max(value, 0), 1);

/** A range within the zooms a tile is named at. */
export function clampedTileGridZoomRange(range: readonly [number, number]): readonly [number, number] {
  const lower = Math.min(Math.max(Math.trunc(range[0]) || 0, 0), ImmersiveMapTileID.maximumZoom);
  const upper = Math.min(Math.max(Math.trunc(range[1]) || 0, lower), ImmersiveMapTileID.maximumZoom);
  return [lower, upper];
}

/**
 * The grid's settings with the values given, the rest as `base` has them,
 * each held to what it can be: a width is not negative, a share lies within
 * 0 to 1, the zooms within those a tile is named at. `selectionLimit` and
 * `selectableBounds` are set when given, null included: null is a value
 * there, no limit and the whole map.
 */
export function tileGridSettings(options: Options<TileGridSettings> = {}, base: TileGridSettings = defaultTileGridSettings): TileGridSettings {
  const o = options as Partial<TileGridSettings>;
  const bounds = o.selectableBounds === undefined ? base.selectableBounds : o.selectableBounds;
  return deepFreeze({
    zoomRange: clampedTileGridZoomRange(o.zoomRange ?? base.zoomRange),
    minimumTileScreenPoints: Math.max(o.minimumTileScreenPoints ?? base.minimumTileScreenPoints, 1),
    labelMinimumTileScreenPoints: Math.max(o.labelMinimumTileScreenPoints ?? base.labelMinimumTileScreenPoints, 1),
    maximumDrawnTiles: Math.max(Math.trunc(o.maximumDrawnTiles ?? base.maximumDrawnTiles) || 0, 0),
    lineColor: [...(o.lineColor ?? base.lineColor)] as unknown as Rgba,
    lineWidthPoints: Math.max(o.lineWidthPoints ?? base.lineWidthPoints, 0),
    labelColor: [...(o.labelColor ?? base.labelColor)] as unknown as Rgba,
    labelHaloColor: [...(o.labelHaloColor ?? base.labelHaloColor)] as unknown as Rgba,
    labelHaloWidthPoints: Math.max(o.labelHaloWidthPoints ?? base.labelHaloWidthPoints, 0),
    selectedFillColor: [...(o.selectedFillColor ?? base.selectedFillColor)] as unknown as Rgba,
    labelFormat: o.labelFormat ?? base.labelFormat,
    labelMaximumWidthShare: share(o.labelMaximumWidthShare ?? base.labelMaximumWidthShare),
    labelMaximumHeightShare: share(o.labelMaximumHeightShare ?? base.labelMaximumHeightShare),
    isTapSelectionEnabled: o.isTapSelectionEnabled ?? base.isTapSelectionEnabled,
    selectionGesture: o.selectionGesture ?? base.selectionGesture,
    selectionMode: o.selectionMode ?? base.selectionMode,
    selectionLimit: o.selectionLimit === undefined ? base.selectionLimit : o.selectionLimit === null ? null : Math.max(Math.trunc(o.selectionLimit) || 0, 0),
    selectableBounds:
      bounds === null
        ? null
        : { southWest: { latitude: bounds.southWest.latitude, longitude: bounds.southWest.longitude }, northEast: { latitude: bounds.northEast.latitude, longitude: bounds.northEast.longitude } },
  });
}
