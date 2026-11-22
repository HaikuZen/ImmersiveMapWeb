// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapCameraState } from "../../../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../../../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../../../camera/render-camera-pose-resolver.ts";
import { defaultPresentationSettings } from "../../../configuration/presentation-settings.ts";
import { GeoScreenProjectionFrameConstants } from "../../../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import { PresentationStateResolver } from "../../../presentation/presentation-state-resolver.ts";
import type { DebugFrameReport } from "../../../render/debug/debug-frame-report.ts";
import type { PlaceTile, ResidentTile } from "../../../tile/placement/place-tile.ts";

/** A camera looking at a point: latitude and longitude in degrees, bearing and pitch in radians. */
export interface DebugFrameFixtureCamera {
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number;
  readonly bearing?: number;
  readonly pitch?: number;
}

/**
 * A frame report as `ImmersiveMap.drawFrame` fills it, for the debug
 * overlay's tests: the camera and the presentation resolved as the renderer
 * resolves them (`PresentationStateResolver`, `RenderCamera` and its pose
 * resolver), the given placements, no relief and no labels.
 */
export function makeDebugFrameReport(
  camera: DebugFrameFixtureCamera,
  placements: readonly PlaceTile<ResidentTile>[],
  overrides: Partial<DebugFrameReport> = {},
  drawWidth = 800,
  drawHeight = 600,
): DebugFrameReport {
  const center = ImmersiveMapProjection.worldMercator((camera.latitude * Math.PI) / 180, (camera.longitude * Math.PI) / 180);
  const cameraState = ImmersiveMapCameraState.make(center, camera.zoom, camera.bearing ?? 0, camera.pitch ?? 0);
  const presentation = PresentationStateResolver.resolve(cameraState, defaultPresentationSettings);
  const renderCamera = new RenderCamera();
  renderCamera.recalculateProjection(drawWidth / drawHeight);
  new RenderCameraPoseResolver().updateIfNeeded(renderCamera, cameraState, presentation.presentationState.transition);
  const projectionView = renderCamera.cameraMatrix!.slice();
  const eye = renderCamera.eye;
  return {
    frameIndex: 1,
    drawWidth,
    drawHeight,
    pixelsPerPoint: 1,
    mapCameraState: cameraState,
    planningZoom: camera.zoom,
    animatedZoom: camera.zoom,
    cameraEye: eye,
    projectionView,
    renderSurfaceMode: presentation.renderSurfaceMode,
    transition: presentation.presentationState.transition,
    flatRenderState: presentation.flatRenderState,
    projection: new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, { matrix: projectionView, eye }, presentation),
    tileZoomLevel: Math.floor(camera.zoom),
    flatRingBands: [],
    placements,
    reliefFrame: undefined,
    terrainSurroundings: undefined,
    terrainFollowReport: undefined,
    timings: { frameDeltaSeconds: 0.0167, cpuMilliseconds: 2.5, gpuMilliseconds: undefined, drawCount: 40 },
    tiles: { visible: placements.length, ready: placements.length, requested: 0, rendered: placements.length },
    pending: { terrainTiles: 0, layerMeshes: 0, sceneModelMeshes: 0 },
    ...overrides,
  };
}
