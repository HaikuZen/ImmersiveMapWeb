// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The map's camera in the terms of its public API (`ImmersiveMap.view`, the
 * `camera` option) and the per-frame statistics it reports: plain values and
 * the conversions to and from the engine's `ImmersiveMapCameraPosition`.
 */

import { ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import type { ImmersiveMapCity } from "../geo/immersive-map-city.ts";

/** Where the camera is: the point it looks at, the zoom, and radians of bearing and pitch. */
export interface MapView {
  readonly center: readonly [longitude: number, latitude: number];
  readonly zoom: number;
  /** Radians from north, clockwise as the map turns. */
  readonly bearing: number;
  /** Radians from straight down. */
  readonly pitch: number;
}

/**
 * Where the camera opens: a view (what it leaves out stays as it is), a
 * city's centre (`ImmersiveMapCity`, at the city zoom unless one is given),
 * or a camera position as the controller speaks it.
 */
export type ImmersiveMapCameraOption =
  | Partial<MapView>
  | { readonly city: ImmersiveMapCity; readonly zoom?: number; readonly bearing?: number; readonly pitch?: number }
  | ImmersiveMapCameraPosition;

export function viewFromCameraPosition(position: ImmersiveMapCameraPosition): MapView {
  return { center: [position.longitudeDegrees, position.latitudeDegrees], zoom: position.zoom, bearing: position.bearing, pitch: position.pitch };
}

/** The position `option` names, over `current` for what a view leaves out. */
export function cameraPositionFromOption(option: ImmersiveMapCameraOption, current: ImmersiveMapCameraPosition = ImmersiveMapCameraPosition.default): ImmersiveMapCameraPosition {
  if ("latitudeDegrees" in option) return option;
  if ("city" in option) {
    return ImmersiveMapCameraPosition.city(option.city, option.zoom ?? ImmersiveMapCameraPosition.cityZoom, option.bearing ?? 0, option.pitch ?? 0);
  }
  return {
    longitudeDegrees: option.center?.[0] ?? current.longitudeDegrees,
    latitudeDegrees: option.center?.[1] ?? current.latitudeDegrees,
    zoom: option.zoom ?? current.zoom,
    bearing: option.bearing ?? current.bearing,
    pitch: option.pitch ?? current.pitch,
  };
}

/** One drawn frame, as `ImmersiveMap.onFrame` reports it. */
export interface FrameEvent {
  readonly frameNumber: number;
  /** The frame's main-thread time: camera, coverage, working set, uniforms, encoding and submit. */
  readonly cpuMilliseconds: number;
  /** The world pass's GPU time of the last frame measured, `undefined` without `timestamp-query`. */
  readonly gpuMilliseconds: number | undefined;
  /** Draw records the frame encoded (one per drawn tile layer and per placement mark). */
  readonly draws: number;
  /** The coverage's targets. */
  readonly visibleTiles: number;
  /** The placements drawn, the stand-ins and the horizon backdrop included. */
  readonly renderedTiles: number;
  /** The demanded tiles not resident yet. */
  readonly loadingTiles: number;
  /** The terrain tiles the ground relief asked for and has not got yet, 0 without a relief. */
  readonly pendingTerrainTiles: number;
  /** The layers of the app's data the frame draws whose meshes are not ready yet: their source being read or their mesh being built. */
  readonly pendingLayerMeshes: number;
  /** The 3D models still on their way: the app's scene model meshes and the model archive's tiles (a capture waits for both). */
  readonly pendingSceneModelMeshes: number;
  /** The layers of the app's data the frame drew. */
  readonly drawnAppLayers: number;
  /** The tiles of the tile grid the frame drew, 0 without a grid. */
  readonly drawnTileGridTiles: number;
  /** The globe-to-plane transition the frame was drawn at, 0 the globe and 1 the plane. */
  readonly transition: number;
  /**
   * Whether anything the frame wants is still on its way: map tiles, terrain
   * or layer meshes (the Swift `ImmersiveMapRenderedFrame.hasPendingWork`, a
   * still capture's settle condition without its animations). Zero visible
   * tiles before the first request also reads as nothing pending, so check
   * `visibleTiles` too.
   */
  readonly hasPendingWork: boolean;
}

export interface FrameEventInputs {
  readonly frameNumber: number;
  readonly cpuStart: number;
  readonly cpuEnd: number;
  readonly gpuMilliseconds: number | undefined;
  readonly draws: number;
  readonly placement: { readonly visibleTilesCount: number; readonly renderedTilesCount: number; readonly requestedTilesCount: number };
  readonly transition: number;
  readonly pendingTerrainTiles?: number;
  readonly pendingLayerMeshes?: number;
  readonly pendingSceneModelMeshes?: number;
  readonly drawnAppLayers?: number;
  readonly drawnTileGridTiles?: number;
}

export function makeFrameEvent(inputs: FrameEventInputs): FrameEvent {
  return {
    frameNumber: inputs.frameNumber,
    cpuMilliseconds: Math.max(0, inputs.cpuEnd - inputs.cpuStart),
    gpuMilliseconds: inputs.gpuMilliseconds,
    draws: inputs.draws,
    visibleTiles: inputs.placement.visibleTilesCount,
    renderedTiles: inputs.placement.renderedTilesCount,
    loadingTiles: inputs.placement.requestedTilesCount,
    pendingTerrainTiles: inputs.pendingTerrainTiles ?? 0,
    pendingLayerMeshes: inputs.pendingLayerMeshes ?? 0,
    pendingSceneModelMeshes: inputs.pendingSceneModelMeshes ?? 0,
    drawnAppLayers: inputs.drawnAppLayers ?? 0,
    drawnTileGridTiles: inputs.drawnTileGridTiles ?? 0,
    transition: inputs.transition,
    hasPendingWork: inputs.placement.requestedTilesCount > 0 || (inputs.pendingTerrainTiles ?? 0) > 0 || (inputs.pendingLayerMeshes ?? 0) > 0 || (inputs.pendingSceneModelMeshes ?? 0) > 0,
  };
}
