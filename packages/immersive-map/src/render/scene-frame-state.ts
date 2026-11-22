// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraFrameState } from "../camera/frame-camera-state-resolver.ts";
import type { Rgba } from "../configuration/color.ts";
import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";

/**
 * What the scene subsystems (the starfield, the horizon, the ground fog)
 * read of a frame beyond the engine's `FrameContext`: the parts of the
 * Swift `FrameContext` that carry the camera, the presentation and the
 * clock. The host fills it once a frame before the engine encodes, and the
 * camera frame is the resolver's own object, valid for that frame only.
 */
export interface SceneFrameState {
  readonly settings: ImmersiveMapSettings;
  readonly cameraFrame: CameraFrameState;
  readonly presentation: ResolvedPresentationState;
  /** The style's map colour (`ImmersiveMapBaseColors.map`). */
  readonly mapColor: Rgba;
  /** The frame's clock in seconds (the stars' twinkle). */
  readonly timeSeconds: number;
  /**
   * The frame's ground relief as the fog reads it: whether the frame is on
   * the terrain and the datum the ground is drawn from, `undefined` on a map
   * without a relief.
   */
  readonly groundRelief?: { readonly isActive: boolean; readonly datumMetres: number } | undefined;
  /** How mountainous the country around the camera reads (`ImmersiveMapTerrainSurroundings`), 0 off the terrain. */
  readonly mountainousness?: number | undefined;
  /**
   * The camera's zoom followed over time (`AnimatedZoom`), what the air reads
   * (the Swift `FrameContext.animatedZoom`): the camera's own zoom when left out.
   */
  readonly animatedZoom?: number | undefined;
}
