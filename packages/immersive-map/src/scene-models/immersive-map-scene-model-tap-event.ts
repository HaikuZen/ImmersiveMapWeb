// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import type { ImmersiveMapScreenPoint } from "../selection/immersive-map-selection.ts";
import type { ImmersiveMapSceneModel } from "./immersive-map-scene-model.ts";

/**
 * A tap on a 3D scene model, a port of the Swift
 * `ImmersiveMapSceneModelTapEvent`. Delivered on every tap that lands on the
 * model's geometry, regardless of selection state, including a repeated tap
 * on an already selected model.
 */
export interface ImmersiveMapSceneModelTapEvent {
  /** The model descriptor at the moment of the tap. */
  readonly model: ImmersiveMapSceneModel;
  /**
   * Where the model was drawn when it was tapped. During a path animation
   * this is the point of the flight the model had reached, while
   * `model.coordinate` already holds the path's destination.
   */
  readonly coordinate: GeoCoordinate;
  /** Where the tap landed, in CSS pixels of the map's element. */
  readonly screenPoint: ImmersiveMapScreenPoint;
}
