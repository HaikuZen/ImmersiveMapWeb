// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type CameraSettings, clampPitch, clampZoom } from "../configuration/camera-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec2 } from "../math/vec.ts";
import { CameraBoundsConstraint } from "./camera-bounds-constraint.ts";
import type { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";

/**
 * The `camera` folder: camera state, constraints (bearing, pitch, zoom
 * limits, region bounds) and the gesture-independent zoom and view-mode math
 * that the UI, the presentation, tile visibility and the renderer share
 * without owning camera policy. No gesture recognizers or DOM, no GPU or
 * frame state, no tile loading or style configuration, no label, pin or
 * starfield state.
 *
 * A camera state is an immutable value: a change is a new state.
 */
export interface ImmersiveMapCameraState {
  /** The point the camera looks at, normalized world Mercator (x east, y south, both 0...1). */
  readonly centerWorldMercator: Vec2;
  readonly zoom: number;
  /** Radians. */
  readonly bearing: number;
  /** Radians from straight down. */
  readonly pitch: number;
}

export const ImmersiveMapCameraState = {
  default: Object.freeze({ centerWorldMercator: Object.freeze([0.5, 0.5] as const), zoom: 0, bearing: 0, pitch: 0 }) as ImmersiveMapCameraState,

  /** A state with the center's x wrapped into the world and its y clamped to it. */
  make(centerWorldMercator: Vec2, zoom: number, bearing: number, pitch: number): ImmersiveMapCameraState {
    return {
      centerWorldMercator: [
        ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]),
        ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]),
      ],
      zoom,
      bearing,
      pitch,
    };
  },

  /** The state of a position under the settings: the latitude, zoom and pitch clamped, the center held to the bounds. */
  fromPosition(cameraPosition: ImmersiveMapCameraPosition, cameraSettings: CameraSettings): ImmersiveMapCameraState {
    const maxLatitudeDeg = ImmersiveMapProjection.maxMercatorLatitude * (180.0 / Math.PI);
    const clampedLatitudeDegrees = Math.min(Math.max(cameraPosition.latitudeDegrees, -maxLatitudeDeg), maxLatitudeDeg);
    const latitudeRadians = (clampedLatitudeDegrees / 180.0) * Math.PI;
    const longitudeRadians = (cameraPosition.longitudeDegrees / 180.0) * Math.PI;
    const centerWorldMercator = ImmersiveMapProjection.worldMercator(latitudeRadians, longitudeRadians);
    const clampedZoom = clampZoom(cameraSettings, cameraPosition.zoom);
    const boundedCenter =
      cameraSettings.bounds === null ? centerWorldMercator : new CameraBoundsConstraint(cameraSettings.bounds).apply(centerWorldMercator, clampedZoom);
    return ImmersiveMapCameraState.make(boundedCenter, clampedZoom, cameraPosition.bearing, clampPitch(cameraSettings, cameraPosition.pitch, clampedZoom));
  },

  cameraPosition(state: ImmersiveMapCameraState): ImmersiveMapCameraPosition {
    const latitudeRadians = ImmersiveMapProjection.latitudeFromNormalizedWorldY(state.centerWorldMercator[1]);
    const longitudeRadians = ImmersiveMapProjection.longitudeFromNormalizedWorldX(state.centerWorldMercator[0]);
    return {
      latitudeDegrees: latitudeRadians * (180.0 / Math.PI),
      longitudeDegrees: longitudeRadians * (180.0 / Math.PI),
      zoom: state.zoom,
      bearing: state.bearing,
      pitch: state.pitch,
    };
  },

  equals(a: ImmersiveMapCameraState, b: ImmersiveMapCameraState): boolean {
    return (
      a.centerWorldMercator[0] === b.centerWorldMercator[0] &&
      a.centerWorldMercator[1] === b.centerWorldMercator[1] &&
      a.zoom === b.zoom &&
      a.bearing === b.bearing &&
      a.pitch === b.pitch
    );
  },
} as const;
