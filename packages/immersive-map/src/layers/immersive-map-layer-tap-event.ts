// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import type { ImmersiveMapScreenPoint } from "../selection/immersive-map-selection.ts";
import type { ImmersiveMapLayer } from "./immersive-map-layer.ts";

/**
 * A tap on a shape of a layer of the app's data (`ImmersiveMap.onLayerTap`),
 * the Swift `ImmersiveMapLayerTapEvent`. Delivered on every tap that lands
 * on a shape the map shows, whatever the selection, a repeated tap on a
 * selected shape included.
 */
export interface ImmersiveMapLayerTapEvent {
  /** The layer the shape is drawn by, as it was at the moment of the tap. Its `source` names the registered data the shape comes from. */
  readonly layer: ImmersiveMapLayer;
  /** The shape's id within the layer's source: the one it was given, a GeoJSON feature's numeric `id`, or its place in the source. */
  readonly shapeID: number;
  /** The place on the map under the tap. */
  readonly coordinate: GeoCoordinate;
  /** The tap in CSS pixels of the map's element, origin top left. */
  readonly screenPoint: ImmersiveMapScreenPoint;
}
