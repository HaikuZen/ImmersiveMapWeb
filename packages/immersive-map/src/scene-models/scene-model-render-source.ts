// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import type { ImmersiveMapGeoPath } from "../geo/immersive-map-geo-path.ts";
import type { ImmersiveMapPathAnimationCurve } from "../geo/immersive-map-path-animation-curve.ts";
import type { ImmersiveMapSceneModel } from "./immersive-map-scene-model.ts";
import type { ImmersiveMapSceneModelsController } from "./immersive-map-scene-models-controller.ts";

/**
 * A request to fly a model along a path, collected by the public controller
 * and started by the presentation store on the frame that applies it.
 */
export interface SceneModelPathAnimationRequest {
  /**
   * Distinguishes this request from a later `animate` for the same id, so a
   * result that arrives after a supersede cannot resolve the new animation.
   */
  readonly generation: number;
  readonly path: ImmersiveMapGeoPath;
  /** Seconds. */
  readonly duration: number;
  readonly curve: ImmersiveMapPathAnimationCurve;
  readonly appliesHeading: boolean;
  readonly appliesPitch: boolean;
}

/**
 * Where a path animation left the model, reported back so the controller's
 * descriptor keeps telling the truth: a cancelled animation stops partway,
 * and nothing else knows where that is.
 */
export interface SceneModelPathAnimationResult {
  readonly id: number;
  readonly generation: number;
  /** True when the model reached the end of the path. */
  readonly finished: boolean;
  readonly coordinate: GeoCoordinate;
  readonly altitudeMeters: number;
  readonly headingDegrees: number;
  readonly pitchDegrees: number;
}

/**
 * Scene model mutations collected by the public controller and consumed
 * destructively by the render subsystem.
 */
export interface SceneModelsSnapshot {
  readonly models: readonly ImmersiveMapSceneModel[];
  /**
   * Seconds of the transform (orientation, scale, altitude) animation
   * requested for a model in this snapshot. Absent means snap.
   */
  readonly transformAnimationDurationsById: ReadonlyMap<number, number>;
  /** Path animations started in this snapshot. */
  readonly pathAnimationsById: ReadonlyMap<number, SceneModelPathAnimationRequest>;
  /**
   * Path animations the app cancelled. The store drops them without
   * touching the model's displayed transform.
   */
  readonly cancelledPathAnimationIds: readonly number[];
  readonly removedIds: readonly number[];
  readonly version: number;
}

/** A snapshot with the fields given and the rest empty, as the Swift initializer's defaults. */
export function makeSceneModelsSnapshot(fields: {
  readonly models: readonly ImmersiveMapSceneModel[];
  readonly transformAnimationDurationsById?: ReadonlyMap<number, number>;
  readonly pathAnimationsById?: ReadonlyMap<number, SceneModelPathAnimationRequest>;
  readonly cancelledPathAnimationIds?: readonly number[];
  readonly removedIds?: readonly number[];
  readonly version?: number;
}): SceneModelsSnapshot {
  return {
    models: fields.models,
    transformAnimationDurationsById: fields.transformAnimationDurationsById ?? new Map(),
    pathAnimationsById: fields.pathAnimationsById ?? new Map(),
    cancelledPathAnimationIds: fields.cancelledPathAnimationIds ?? [],
    removedIds: fields.removedIds ?? [],
    version: fields.version ?? 0,
  };
}

/** The single seam between the renderer and the UI-side ownership of the scene models. */
export interface SceneModelRenderSource {
  readonly currentSceneModelsController: ImmersiveMapSceneModelsController | null;
}
