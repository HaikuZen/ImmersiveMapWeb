// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type CameraConstraints, CameraConstraintResolver } from "../camera/camera-constraint-resolver.ts";
import { GlobeUprightPull, type GlobeUprightWindow } from "../camera/globe-upright-pull.ts";
import type { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import type { ViewMode } from "../camera/view-mode.ts";
import type { CameraPresentationSettings } from "./camera-presentation-settings.ts";
import { PresentationStateResolver } from "./presentation-state-resolver.ts";
import type { ResolvedPresentationState } from "./resolved-presentation-state.ts";

/** Stores the map's current surface mode and resolves the presentation state for the frame pipeline. */
export class MapPresentationStateController {
  private settings: CameraPresentationSettings;
  private forcedRenderSurfaceMode: ViewMode | null = null;

  constructor(settings: CameraPresentationSettings) {
    this.settings = settings;
  }

  applySettings(settings: CameraPresentationSettings): void {
    this.settings = settings;
  }

  resolve(cameraState: ImmersiveMapCameraState): ResolvedPresentationState {
    return PresentationStateResolver.resolve(cameraState, this.settings.presentation, this.forcedRenderSurfaceMode);
  }

  /**
   * The debug panel's switch: forces the surface opposite the one shown, and
   * a second switch returns to the automatic choice.
   */
  switchRenderSurfaceMode(cameraState: ImmersiveMapCameraState): void {
    if (this.forcedRenderSurfaceMode !== null) {
      this.forcedRenderSurfaceMode = null;
      return;
    }
    const resolvedPresentation = this.resolve(cameraState);
    this.forcedRenderSurfaceMode = resolvedPresentation.renderSurfaceMode === "spherical" ? "flat" : "spherical";
  }

  isSphericalSurfaceActive(cameraState: ImmersiveMapCameraState): boolean {
    return this.resolve(cameraState).renderSurfaceMode === "spherical";
  }

  cameraConstraints(cameraState: ImmersiveMapCameraState): CameraConstraints {
    return CameraConstraintResolver.resolve(cameraState, this.settings.camera, this.resolve(cameraState).renderSurfaceMode);
  }

  /** The window the globe's upright pull holds the camera to, null where it holds nothing. */
  globeUprightWindow(cameraState: ImmersiveMapCameraState): GlobeUprightWindow | null {
    const renderSurfaceMode = this.resolve(cameraState).renderSurfaceMode;
    return GlobeUprightPull.window(
      cameraState.zoom,
      this.settings.camera.globeUprightPull,
      renderSurfaceMode,
      CameraConstraintResolver.resolve(cameraState, this.settings.camera, renderSurfaceMode),
    );
  }
}
