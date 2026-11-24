// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { themesPrepareAlike } from "../style/theme.ts";
import { deepEqual } from "./deep.ts";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import type { ImmersiveMapSettingsData } from "./immersive-map-settings.ts";
import { modelArchivesDifferInDepthBiasAlone } from "./model-archive-settings.ts";
import { resolvedMaximumZoomLevel } from "./tile-settings.ts";

/** The part of the settings a change touches. */
export type ImmersiveMapSettingsChangeDomain =
  | "renderLoop"
  | "camera"
  | "presentation"
  | "tiles"
  | "labels"
  | "scene"
  | "style"
  | "pins"
  | "attribution"
  | "postProcessing"
  | "debug"
  | "controls"
  | "modelArchive"
  | "tileGrid";

/** Every change domain, in the order declared. */
export const settingsChangeDomains: readonly ImmersiveMapSettingsChangeDomain[] = Object.freeze([
  "renderLoop",
  "camera",
  "presentation",
  "tiles",
  "labels",
  "scene",
  "style",
  "pins",
  "attribution",
  "postProcessing",
  "debug",
  "controls",
  "modelArchive",
  "tileGrid",
]);

/**
 * What applying a change takes: `liveApply` on the next frame, or the
 * heavier steps, the caches thrown away, the prepared tiles prepared again,
 * the GPU resources built again, the renderer recreated.
 */
export type ImmersiveMapSettingsApplyAction =
  | "liveApply"
  | "invalidateCaches"
  | "rebuildPreparedData"
  | "rebuildGPUResources"
  | "recreateRenderer";

/** Every apply action, in the order declared. */
export const settingsApplyActions: readonly ImmersiveMapSettingsApplyAction[] = Object.freeze([
  "liveApply",
  "invalidateCaches",
  "rebuildPreparedData",
  "rebuildGPUResources",
  "recreateRenderer",
]);

/** How a settings change is applied: the domains it touched and the actions it takes. */
export interface ImmersiveMapSettingsApplicationPlan {
  readonly changedDomains: ReadonlySet<ImmersiveMapSettingsChangeDomain>;
  readonly actions: ReadonlySet<ImmersiveMapSettingsApplyAction>;
  /** Whether the renderer is recreated, which the map rebuilds itself for. */
  readonly requiresRendererRecreation: boolean;
}

/**
 * Builds a plan for applying new settings, separating live updates from
 * changes that require recreating the renderer because of caches, prepared
 * data, or GPU resources. This logic lives outside the settings because
 * settings describe state, while deciding how to apply them belongs to the
 * map's runtime policy.
 */
export function planSettingsApplication(
  previousSettings: ImmersiveMapSettings | ImmersiveMapSettingsData,
  nextSettings: ImmersiveMapSettings | ImmersiveMapSettingsData,
): ImmersiveMapSettingsApplicationPlan {
  const previous = previousSettings instanceof ImmersiveMapSettings ? previousSettings.data : previousSettings;
  const next = nextSettings instanceof ImmersiveMapSettings ? nextSettings.data : nextSettings;
  const changedDomains = new Set<ImmersiveMapSettingsChangeDomain>();
  const actions = new Set<ImmersiveMapSettingsApplyAction>();
  const mark = (domain: ImmersiveMapSettingsChangeDomain, domainActions: readonly ImmersiveMapSettingsApplyAction[]): void => {
    changedDomains.add(domain);
    for (const action of domainActions) {
      actions.add(action);
    }
  };
  const differ = (a: unknown, b: unknown): boolean => !deepEqual(a, b);

  if (differ(previous.renderLoop, next.renderLoop)) {
    mark("renderLoop", ["liveApply"]);
  }
  if (differ(previous.camera, next.camera)) {
    mark("camera", ["liveApply"]);
  }
  if (differ(previous.presentation, next.presentation)) {
    mark("presentation", ["liveApply"]);
  }
  // The style re-prepares the tiles. The theme's values drawn at frame time
  // (the hillshade, the terrain occlusion, the labels' opacity, the trees'
  // palette) are baked into nothing and apply live. The Swift style
  // compares by its cache fingerprint, which leaves them out, so there they
  // reach the renderer without a plan of their own.
  if (!themesPrepareAlike(previous.mapStyle.theme, next.mapStyle.theme)) {
    mark("style", ["invalidateCaches", "rebuildPreparedData", "rebuildGPUResources", "recreateRenderer"]);
  } else if (differ(previous.mapStyle, next.mapStyle)) {
    mark("style", ["liveApply"]);
  }
  if (previous.debug.enableDebugPanel !== next.debug.enableDebugPanel) {
    mark("debug", ["recreateRenderer"]);
  } else if (differ(previous.debug, next.debug)) {
    mark("debug", ["liveApply"]);
  }

  // Light, shadows and the atmosphere are per-frame uniforms read from the
  // frame's context. The shadow-map texture is reallocated lazily on
  // resolution change, so all of them apply live without recreating the
  // renderer.
  const sceneLiveChanged =
    differ(previous.scene.space, next.scene.space) ||
    differ(previous.scene.light, next.scene.light) ||
    differ(previous.scene.shadows, next.scene.shadows) ||
    differ(previous.scene.atmosphere, next.scene.atmosphere) ||
    differ(previous.scene.fog, next.scene.fog) ||
    differ(previous.scene.groundFog, next.scene.groundFog) ||
    differ(previous.scene.mountainGroundFog, next.scene.mountainGroundFog);
  if (sceneLiveChanged) {
    mark("scene", ["liveApply"]);
  }
  if (differ(previous.scene.starfield, next.scene.starfield)) {
    mark("scene", ["rebuildGPUResources", "recreateRenderer"]);
  }

  // The depth decides how the tiles are parsed (the quarters a tile coarser
  // than the deepest keeps) and the prepared tiles' namespace, both built
  // with the renderer. The rest of the coverage is read per frame.
  if (resolvedMaximumZoomLevel(previous.tiles.coverage) !== resolvedMaximumZoomLevel(next.tiles.coverage)) {
    mark("tiles", ["rebuildPreparedData", "recreateRenderer"]);
  } else if (differ(previous.tiles.coverage, next.tiles.coverage)) {
    mark("tiles", ["liveApply"]);
  }
  if (differ(previous.tiles.network, next.tiles.network) || differ(previous.tiles.cache, next.tiles.cache)) {
    mark("tiles", ["invalidateCaches", "recreateRenderer"]);
  }
  if (differ(previous.tiles.parsing, next.tiles.parsing)) {
    mark("tiles", ["invalidateCaches", "rebuildPreparedData", "recreateRenderer"]);
  }
  // The raster tiles' sampler is built with the renderer, and the textures
  // are drawn anew every frame.
  if (differ(previous.tiles.rasterization, next.tiles.rasterization)) {
    mark("tiles", ["recreateRenderer"]);
  }
  // The overview is laid into the tiles by the load pipeline, built with the
  // renderer, and baked into the prepared tiles, whose identity it is part
  // of.
  if (previous.tiles.overview.isEnabled !== next.tiles.overview.isEnabled) {
    mark("tiles", ["invalidateCaches", "rebuildPreparedData", "recreateRenderer"]);
  }

  // Every label field, the on/off switch included, changes what a prepared
  // tile carries: with labels off the parser bakes no text.
  if (differ(previous.labels, next.labels)) {
    mark("labels", ["invalidateCaches", "rebuildPreparedData", "recreateRenderer"]);
  }
  if (differ(previous.pins, next.pins)) {
    mark("pins", ["rebuildGPUResources", "recreateRenderer"]);
  }
  // The badge shows the resolved attribution, which the overview's credit is
  // part of: its zoom is badge text, applied in place.
  if (differ(previous.attribution, next.attribution) || differ(previous.tiles.overview, next.tiles.overview)) {
    mark("attribution", ["liveApply"]);
  }
  // The controls are views over the map: hidden and shown in place.
  if (differ(previous.controls, next.controls)) {
    mark("controls", ["liveApply"]);
  }
  // FXAA is a pass-plan flag read per frame. The sample count is baked into
  // every pipeline state, so it rebuilds the renderer.
  if (differ(previous.postProcessing, next.postProcessing)) {
    if (previous.postProcessing.multisampleCount === next.postProcessing.multisampleCount) {
      mark("postProcessing", ["liveApply"]);
    } else {
      mark("postProcessing", ["rebuildGPUResources", "recreateRenderer"]);
    }
  }

  // The archive client, the disk cache and the memory budget are built with
  // the renderer. The map's own tiles are untouched: they do not depend on
  // the models. The depth bias alone is read per frame.
  if (differ(previous.modelArchive, next.modelArchive)) {
    if (modelArchivesDifferInDepthBiasAlone(previous.modelArchive, next.modelArchive)) {
      mark("modelArchive", ["liveApply"]);
    } else {
      mark("modelArchive", ["recreateRenderer"]);
    }
  }

  // The grid is worked out anew every frame from its settings.
  if (differ(previous.tileGrid, next.tileGrid)) {
    mark("tileGrid", ["liveApply"]);
  }

  return { changedDomains, actions, requiresRendererRecreation: actions.has("recreateRenderer") };
}
