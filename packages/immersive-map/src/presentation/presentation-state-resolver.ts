// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import type { ViewMode } from "../camera/view-mode.ts";
import { defaultPresentationSettings, type PresentationSettings } from "../configuration/presentation-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { GlobeUniform } from "../globe/globe-uniform.ts";
import type { ResolvedPresentationState, ScreenSpaceProjectionMode } from "./resolved-presentation-state.ts";

/**
 * The `presentation` folder: the resolved presentation state (globe, flat,
 * the transition between them) that camera, tile, globe and render layers
 * share, computed from camera and view-mode input. It owns neither the UI
 * surface that receives gestures nor the renderer: no DOM, no GPU, no tile
 * loading, no styling or label rules.
 */
export const PresentationStateResolver = {
  /**
   * Fraction of the transition phase by which the morph geometry fully
   * unfolds into the plane.
   */
  geometryCompletionPhase: 0.9,

  /**
   * The presentation of a camera state. `forcedRenderSurfaceMode` (the
   * debug panel's switch) wins over the zoom when given.
   */
  resolve(
    cameraState: ImmersiveMapCameraState,
    settings: PresentationSettings = defaultPresentationSettings,
    forcedRenderSurfaceMode: ViewMode | null = null,
  ): ResolvedPresentationState {
    const renderZoomScale = 2.0 ** Math.floor(cameraState.zoom);
    const automatic = automaticTransition(cameraState, settings);
    const transition = resolvedTransition(automatic, forcedRenderSurfaceMode, settings.isGlobeEnabled);
    const globeRenderRadius = settings.globeRadiusScale * renderZoomScale;
    const flatRenderMapSize = 2.0 * Math.PI * globeRenderRadius;
    const globePan = ImmersiveMapProjection.globePan(cameraState.centerWorldMercator);
    const flatPan = ImmersiveMapProjection.flatPan(cameraState.centerWorldMercator);

    const globe: GlobeUniform = {
      panX: globePan[0],
      panY: globePan[1],
      radius: globeRenderRadius,
      transition: PresentationStateResolver.geometryTransition(transition),
    };
    const renderSurfaceMode: ViewMode = transition >= 1.0 ? "flat" : "spherical";
    const screenSpaceProjectionMode: ScreenSpaceProjectionMode = renderSurfaceMode === "flat" ? "flat" : "globe";

    return {
      semanticWorldState: { cameraState },
      presentationState: { transition },
      renderNormalizationState: { zoomScale: renderZoomScale, globeRenderRadius, flatRenderMapSize },
      renderSurfaceMode,
      screenSpaceProjectionMode,
      globeRenderState: { pan: globePan, renderRadius: globeRenderRadius, globeUniform: globe },
      flatRenderState: { pan: flatPan, renderMapSize: flatRenderMapSize },
    };
  },

  /**
   * Transition for shader geometry (`GlobeUniform`): the unfurl animation
   * completes by `geometryCompletionPhase`, and for the rest of the phase the
   * globe path renders an already finished plane, so the surface switch at
   * t = 1 happens between geometrically identical frames. The semantic
   * transition (fades, fog, surface selection) stays continuous up to 1.
   */
  geometryTransition(transition: number): number {
    return Math.min(1.0, Math.max(0.0, transition) / PresentationStateResolver.geometryCompletionPhase);
  },
} as const;

/**
 * The transition window is the settings' span at every latitude. The flat
 * morph target still grows from `cos(center latitude)` to the full Mercator
 * size over it (see `globeTransitionMapSize` in the shader), but the camera
 * moves out by the same curve (`GlobeCameraProximity`), so nothing visibly
 * inflates and the window needs no stretching.
 */
function automaticTransition(cameraState: ImmersiveMapCameraState, settings: PresentationSettings): number {
  const from = settings.automaticTransitionStartZoom;
  const span = Math.max(Number.MIN_VALUE, settings.automaticTransitionSpan);
  return Math.max(0.0, Math.min(1.0, (cameraState.zoom - from) / span));
}

/**
 * The forced mode (the debug panel's switch) wins. Otherwise the zoom
 * decides, unless the globe is switched off, which is the plane at every
 * zoom.
 */
function resolvedTransition(automatic: number, forcedRenderSurfaceMode: ViewMode | null, isGlobeEnabled: boolean): number {
  switch (forcedRenderSurfaceMode) {
    case null:
      return isGlobeEnabled ? automatic : 1.0;
    case "spherical":
      return 0.0;
    case "flat":
      return 1.0;
  }
}
