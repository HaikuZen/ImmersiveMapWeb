// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import type { ViewMode } from "../camera/view-mode.ts";
import type { GlobeUniform } from "../globe/globe-uniform.ts";
import type { Vec2 } from "../math/vec.ts";

/** How screen-space code projects a point: through the globe (and its unroll) or the flat map. */
export type ScreenSpaceProjectionMode = "globe" | "flat";

export interface ImmersiveMapPresentationState {
  /**
   * The semantic globe-to-plane transition, 0 the globe and 1 the plane:
   * fades, fog and the surface choice read it. The geometry runs slightly
   * ahead of it (`PresentationStateResolver.geometryTransition`).
   */
  readonly transition: number;
}

export interface SemanticWorldState {
  readonly cameraState: ImmersiveMapCameraState;
}

/** The render world's scale at the frame's integer zoom. */
export interface RenderNormalizationState {
  /** `2^floor(zoom)`. */
  readonly zoomScale: number;
  /** `globeRadiusScale * zoomScale`, in render units. */
  readonly globeRenderRadius: number;
  /** `2 pi globeRenderRadius`, the flat map's width in render units. */
  readonly flatRenderMapSize: number;
}

export interface GlobeRenderState {
  readonly pan: Vec2;
  readonly renderRadius: number;
  readonly globeUniform: GlobeUniform;
}

export interface FlatRenderState {
  readonly pan: Vec2;
  readonly renderMapSize: number;
}

/**
 * The presentation of one frame: the globe-to-plane transition and the
 * render states both surfaces draw by. Both are always produced, and the
 * shaders morph between sphere and plane by the transition.
 */
export interface ResolvedPresentationState {
  readonly semanticWorldState: SemanticWorldState;
  readonly presentationState: ImmersiveMapPresentationState;
  readonly renderNormalizationState: RenderNormalizationState;
  readonly renderSurfaceMode: ViewMode;
  readonly screenSpaceProjectionMode: ScreenSpaceProjectionMode;
  readonly globeRenderState: GlobeRenderState;
  readonly flatRenderState: FlatRenderState;
}

export const ResolvedPresentationState = {
  transition(state: ResolvedPresentationState): number {
    return state.presentationState.transition;
  },

  globeRenderUniform(state: ResolvedPresentationState): GlobeUniform {
    return state.globeRenderState.globeUniform;
  },

  cameraState(state: ResolvedPresentationState): ImmersiveMapCameraState {
    return state.semanticWorldState.cameraState;
  },

  flatProjectionInputsEnabled(state: ResolvedPresentationState): boolean {
    return state.screenSpaceProjectionMode === "flat";
  },
} as const;
