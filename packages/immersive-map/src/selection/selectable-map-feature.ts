// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import type { ImmersiveMapScreenPoint, ImmersiveMapSelection, ImmersiveMapSelectionKind } from "./immersive-map-selection.ts";

/**
 * A map feature whose objects a tap or the app can select, a port of the
 * Swift `SelectableMapFeature`. The one way into the selection: a feature
 * implements it in its own folder (`PinSelection`, `LayerSelection`),
 * declares its `ImmersiveMapSelectionKind` there, and is handed to
 * `ImmersiveMapSelectionHandler`, which names no feature.
 */
export interface SelectableMapFeature {
  /** Whether a selection of `kind` names an object of this feature. */
  owns(kind: ImmersiveMapSelectionKind): boolean;
  /**
   * Takes what the feature drew in a frame. Only data of a kind the feature
   * owns arrives. A frame older than the one held is dropped.
   */
  updatePickData(pickData: SelectionPickData): void;
  /** Forgets what was drawn. */
  resetPickData(): void;
  /**
   * The object under `point` (CSS pixels of the map's element, origin top
   * left), from what the feature last drew. `contentsScale` is the
   * drawable's pixels to a CSS pixel.
   */
  hitTest(point: ImmersiveMapScreenPoint, contentsScale: number): SelectionHit | null;
  /** Whether the feature still holds the object `selection` names. */
  contains(selection: ImmersiveMapSelection): boolean;
  /** Draws the object as selected, or as it was. A feature with no selected appearance does nothing. */
  setSelected(isSelected: boolean, selection: ImmersiveMapSelection): void;
  /** Delivers the feature's own tap event for a hit. True when an action of the app took it. */
  deliverTap(hit: SelectionHit, point: ImmersiveMapScreenPoint): boolean;
  /**
   * The gesture the feature's objects are picked by now, a single tap for
   * every feature but one that states another (the tile grid, by its
   * settings). The handler asks a feature only about its own gesture.
   * A single tap when left out.
   */
  readonly tapKind?: MapTapKind;
  /**
   * Whether the feature has anything a gesture of its kind could land on
   * now. While a feature claims the double tap this way, the double tap is
   * its own and does not zoom the map. Asked only of a feature whose kind
   * is not the single tap. False when left out.
   */
  readonly claimsItsTapKind?: boolean;
  /**
   * Whether a tap the feature took ends the map's selection, as a tap on
   * the bare map does. For a feature that covers the ground and whose
   * objects are never the selection themselves (the tile grid): without it
   * nothing under the grid would be a tap away from a selected object.
   * False when left out.
   */
  readonly clearsSelectionOnTap?: boolean;
}

/**
 * The gestures that pick an object on the map, as the gesture controller
 * tells them apart: a tap or a click of the main button, a double tap or a
 * double click, and a click of the secondary button or a long press on a
 * touch screen.
 */
export type MapTapKind = "single" | "double" | "secondary";

/** The object a tap landed on. */
export interface SelectionHit {
  /** The object, as a selection names it. */
  readonly selection: ImmersiveMapSelection;
  /** Where on the map the tap landed on the object, when the feature knows (the point of a zone under the finger). */
  readonly coordinate: GeoCoordinate | null;
}

/**
 * What one feature drew in one frame that a tap can land on. The frame
 * collects these from the features that drew, and the host hands them on
 * once the frame is submitted, so a tap is tested against what is visible.
 */
export interface SelectionPickData {
  /** A kind the feature the data belongs to owns. */
  readonly kind: ImmersiveMapSelectionKind;
  /** The frame that drew it. */
  readonly frameIndex: number;
}

/**
 * CSS pixels of the element (origin top left) to drawable pixels with the y
 * axis flipped: the renderer projects with the origin bottom left
 * (`ScreenPointOutput`), pointer events arrive top left.
 */
export function selectionPixelPoint(point: ImmersiveMapScreenPoint, drawHeight: number, contentsScale: number): { x: number; y: number } {
  return { x: point.x * contentsScale, y: drawHeight - point.y * contentsScale };
}
