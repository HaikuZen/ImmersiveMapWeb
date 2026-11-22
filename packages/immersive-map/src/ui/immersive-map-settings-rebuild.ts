// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { deepEqual } from "../configuration/deep.ts";
import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { ImmersiveMapSettingsApplicationPlan } from "../configuration/settings-application-planner.ts";
import { themesPrepareAlike } from "../style/theme.ts";
import { resolvedMaximumZoomLevel } from "../configuration/tile-settings.ts";

/**
 * How the map applies a settings change, the web host's reading of the
 * planner's plan (`planSettingsApplication`), the Swift
 * `ImmersiveMapHostRuntime.applySettings`:
 * - `none`: nothing changed;
 * - `live`: the running map takes the settings in place on its next frame;
 * - `tiles`: the tile workers and every tile are built again under the new
 *   settings, the GPU and everything else kept (the path the archive's depth
 *   takes, `TileArchiveDepths`);
 * - `renderer`: the map's GPU side is built again, as the Swift host
 *   recreates its renderer.
 */
export type ImmersiveMapSettingsRebuild = "none" | "live" | "tiles" | "renderer";

/**
 * The rebuild a plan takes on the web map. The plan decides whether the
 * Swift renderer is recreated, and the web map reads its reasons:
 * - what the GPU side is built with: the labels, the pins, the network (the
 *   archive itself), the rasterization, the starfield, the sample count and
 *   the model archive but for its depth bias. These rebuild the GPU side;
 * - what the tile workers alone read: the style's prepared part, the parse,
 *   the disk cache, the overview and the archive's depth. These rebuild the
 *   tiles and keep the GPU side;
 * - the debug panel switched on or off, for which Swift recreates its
 *   renderer to instrument the tiles: the web map attaches its tile status
 *   reporter in place, so it applies live.
 * A few groups the Swift renderer reads per frame are built into the web
 * map's subsystems when it is made (the buildings' extrusion, the trees,
 * the ground flattening, and the ground relief but for its surroundings and
 * its shadows, which the frame reads live): the planner leaves them out of
 * every domain, and a change to them rebuilds the GPU side.
 */
export function resolveSettingsRebuild(
  previous: ImmersiveMapSettings,
  next: ImmersiveMapSettings,
  plan: ImmersiveMapSettingsApplicationPlan,
): ImmersiveMapSettingsRebuild {
  if (previous.equals(next)) return "none";
  if (bakedIntoSubsystemsDiffer(previous, next)) return "renderer";
  if (!plan.requiresRendererRecreation) return "live";
  if (gpuSideDiffers(previous, next)) return "renderer";
  return tileWorkersDiffer(previous, next) ? "tiles" : "live";
}

/** The groups the web map's subsystems take when they are made, which the planner reads as live or not at all. */
function bakedIntoSubsystemsDiffer(previous: ImmersiveMapSettings, next: ImmersiveMapSettings): boolean {
  const a = previous.data;
  const b = next.data;
  if (!deepEqual(a.scene.extrusion, b.scene.extrusion) || !deepEqual(a.scene.trees, b.scene.trees)) return true;
  if (!deepEqual(a.tiles.groundFlattening, b.tiles.groundFlattening)) return true;
  return !deepEqual(reliefBuiltPart(a.tiles.groundRelief), reliefBuiltPart(b.tiles.groundRelief));
}

/** The relief's settings without the two the frame reads live. */
function reliefBuiltPart(relief: ImmersiveMapSettings["tiles"]["groundRelief"]): object {
  return { ...relief, surroundings: null, castsShadows: null };
}

/** Whether a group the GPU side is built with changed. */
function gpuSideDiffers(previous: ImmersiveMapSettings, next: ImmersiveMapSettings): boolean {
  const a = previous.data;
  const b = next.data;
  if (!deepEqual(a.labels, b.labels) || !deepEqual(a.pins, b.pins)) return true;
  if (!deepEqual(a.tiles.network, b.tiles.network) || !deepEqual(a.tiles.rasterization, b.tiles.rasterization)) return true;
  if (!deepEqual(a.scene.starfield, b.scene.starfield)) return true;
  if (a.postProcessing.multisampleCount !== b.postProcessing.multisampleCount) return true;
  return !deepEqual({ ...a.modelArchive, depthBias: null }, { ...b.modelArchive, depthBias: null });
}

/** Whether a group the tile workers alone read changed. */
function tileWorkersDiffer(previous: ImmersiveMapSettings, next: ImmersiveMapSettings): boolean {
  const a = previous.data;
  const b = next.data;
  if (!themesPrepareAlike(a.mapStyle.theme, b.mapStyle.theme)) return true;
  if (!deepEqual(a.tiles.parsing, b.tiles.parsing) || !deepEqual(a.tiles.cache, b.tiles.cache)) return true;
  if (a.tiles.overview.isEnabled !== b.tiles.overview.isEnabled) return true;
  return resolvedMaximumZoomLevel(a.tiles.coverage) !== resolvedMaximumZoomLevel(b.tiles.coverage);
}
