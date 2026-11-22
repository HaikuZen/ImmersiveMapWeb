// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The groups of the settings about the map's view rather than what it
// draws: the render loop, the reuse of a dismantled map, the controls over
// the map, the debug panel and the post-processing passes.

import type { Rgb } from "./color.ts";
import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";

export interface RenderLoopSettings {
  /** Whether a frame is drawn on every display refresh, whatever changed. Off by default: the map draws on demand. */
  readonly forceContinuousRendering: boolean;
  /**
   * Requested frame rate while the map is interacting or animating, and
   * whenever `forceContinuousRendering` keeps the loop running. 60 by
   * default. Displays that cannot reach the requested rate clamp to their
   * own maximum, and the browser may cap the effective rate below this
   * value (a background tab, a power saver).
   */
  readonly interactionFramesPerSecond: number;
  /** Exact low-power cadence for label fade animations. It gets no high-refresh headroom. 30 by default. */
  readonly labelFadeFramesPerSecond: number;
}

export const defaultRenderLoopSettings: RenderLoopSettings = Object.freeze({
  forceContinuousRendering: false,
  interactionFramesPerSecond: 60,
  labelFadeFramesPerSecond: 30,
});

/** Render loop settings, every field not stated at the default's value. */
export function renderLoopSettings(options: Options<RenderLoopSettings> = {}): RenderLoopSettings {
  return deepFreeze(mergeOptions(defaultRenderLoopSettings, options));
}

/**
 * Reuse of dismantled map views. When a screen with a map goes away, its
 * renderer (GPU tile cache, text atlases) is parked for `parkedTimeToLive`
 * seconds instead of being destroyed, and the next map adopts it warm. New
 * settings are reconciled on adoption through the regular settings-apply
 * path, so adopting with a different configuration is safe. An adopted map
 * keeps its previous camera unless the new map provides an explicit camera
 * position or an attached camera controller.
 */
export interface ViewReuseSettings {
  /** On by default. */
  readonly isEnabled: boolean;
  /** How long a dismantled map waits for a new one to adopt it, in seconds. 30 by default. */
  readonly parkedTimeToLive: number;
}

export const defaultViewReuseSettings: ViewReuseSettings = Object.freeze({ isEnabled: true, parkedTimeToLive: 30 });

export function viewReuseSettings(options: Options<ViewReuseSettings> = {}): ViewReuseSettings {
  return deepFreeze(mergeOptions(defaultViewReuseSettings, options));
}

/**
 * What is drawn over the map for the person at it to work it by: the debug
 * panel (`DebugSettings.enableDebugPanel`), the camera's on-screen controls
 * and the control zones at the screen's edges (`CameraSettings.controlZones`).
 */
export interface ControlsSettings {
  /**
   * Whether every control is hidden at once, for a clean frame: a
   * screenshot, a recording, a look at the map alone. Each control keeps its
   * configuration and the debug panel the values dragged in it, so showing
   * them again brings them back as they were, and the renderer is not
   * rebuilt either way. The hidden debug panel costs the frame nothing. The
   * attribution stays: the map data's license requires it on screen
   * (`AttributionSettings`). False by default.
   */
  readonly isHidden: boolean;
}

export const defaultControlsSettings: ControlsSettings = Object.freeze({ isHidden: false });

export function controlsSettings(options: Options<ControlsSettings> = {}): ControlsSettings {
  return deepFreeze(mergeOptions(defaultControlsSettings, options));
}

export interface DebugSettings {
  /** Whether the debug panel is drawn over the map. Off by default. A change recreates the renderer, which instruments the tiles for it. */
  readonly enableDebugPanel: boolean;
  /**
   * Whether the debug panel shows the zoom badge in the map's top trailing
   * corner: the camera's zoom and the planning zoom, large, to read at a
   * glance while a gesture is under way. On by default, shown only with the
   * panel.
   */
  readonly showsZoomBadge: boolean;
  readonly coordinateScale: number;
  readonly diagnosticsScale: number;
  readonly leftPadding: number;
  readonly topPadding: number;
  readonly sectionSpacing: number;
  readonly textColor: Rgb;
}

export const defaultDebugSettings: DebugSettings = deepFreeze({
  enableDebugPanel: false,
  showsZoomBadge: true,
  coordinateScale: 80,
  diagnosticsScale: 60,
  leftPadding: 100,
  topPadding: 190,
  sectionSpacing: 28,
  textColor: [0.82, 0.36, 0.0],
});

export function debugSettings(options: Options<DebugSettings> = {}): DebugSettings {
  return deepFreeze(mergeOptions(defaultDebugSettings, options));
}

export interface PostProcessingSettings {
  /**
   * FXAA over the finished frame, off by default: the engine renders at one
   * sample per pixel with the ground lines antialiased analytically in the
   * tile shaders, and FXAA is the optional extra smoothing of geometry
   * silhouettes (building edges most visibly), at the price of one
   * fullscreen pass.
   */
  readonly fxaaEnabled: boolean;
  /**
   * Multisampling of the world pass: 1 (the default) renders one sample per
   * pixel, 4 is MSAA 4x. The device decides what it can do. A count it does
   * not support falls back to the largest one under it that it does. Unlike
   * FXAA this is not a pass over the finished frame but four depth and
   * colour samples per pixel of the whole world pass, which cleans geometry
   * silhouettes (buildings, models) while the tile shaders still run once
   * per pixel. The frame costs more in memory bandwidth and the overlay
   * (labels, pins) takes its own pass over the resolved image. Every
   * pipeline state depends on it, so changing it recreates the renderer.
   */
  readonly multisampleCount: number;
}

export const defaultPostProcessingSettings: PostProcessingSettings = Object.freeze({
  fxaaEnabled: false,
  multisampleCount: 1,
});

export function postProcessingSettings(options: Options<PostProcessingSettings> = {}): PostProcessingSettings {
  return deepFreeze(mergeOptions(defaultPostProcessingSettings, options));
}
