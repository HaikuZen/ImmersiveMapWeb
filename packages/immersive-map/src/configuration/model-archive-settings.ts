// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { deepEqual, deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";
import { ImmersiveMapTilesService } from "./tiles-service.ts";
import { mapZoomCurve, zoomCurve, zoomCurveValue } from "./zoom-curve.ts";
import type { ImmersiveMapZoomCurve, ZoomCurveInput } from "./zoom-curve.ts";

/** The GPU memory the loaded model tiles may hold by default: 128 MiB. */
export const defaultModelMemoryBudgetInBytes = 128 * 1024 * 1024;

/** The byte quota of the model tiles kept on disk by default: 512 MiB. */
export const defaultModelDiskCacheSizeInBytes = 512 * 1024 * 1024;

/** The largest depth bias a stop may take. */
export const maximumModelDepthBias = 0.25;

/**
 * The bias at the models' zoom, where the map's merged buildings reach out
 * of them, and a trace of it from zoom 15.5 on, where every building is its
 * own and left out under its model: more there would put a model over a
 * tree or a building standing right before it.
 */
export const defaultModelDepthBias: ImmersiveMapZoomCurve = zoomCurve({ 14: 0.05, 15.5: 0.01 });

function clampedDepthBiasValue(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), maximumModelDepthBias) : 0;
}

/** The curve with every stop within `0...maximumModelDepthBias`, a stop that is not a number at 0. */
export function clampedModelDepthBias(curve: ZoomCurveInput): ImmersiveMapZoomCurve {
  return mapZoomCurve(zoomCurve(curve), clampedDepthBiasValue);
}

/**
 * Where the 3D models of the map's buildings come from: one archive of
 * model tiles, read tile by tile as the camera moves.
 *
 * The archive is a PMTiles v3 file whose tiles hold models and not map data:
 * each zoom 14 tile carries every model whose origin lies in it, merged into
 * one mesh ready for the GPU, so a tile of models is one draw. It is
 * requested on its own, apart from the map's tiles: the models of the tiles
 * in view are loaded, each stands in for the map's own building once it is
 * loaded, and the models of the tiles left behind are released when the
 * memory budget is passed.
 */
export interface ModelArchiveSettings {
  /**
   * The archive, over HTTP(S) range requests. A query string is sent as
   * written, so a key can live there. Null by default: the web map draws no
   * models unless the app names an archive, for example the hosted one
   * (`ImmersiveMapTilesService.modelArchiveURL`). The Swift engine reads the
   * hosted archive by default. The web port leaves it off for now because
   * the hosted Kremlin tile alone takes the GPU frame past its budget at
   * zoom 14 (docs/STATUS.md, stage 7).
   */
  readonly archiveURL: string | null;
  /** HTTP header fields added to every archive request, for credentials that travel as headers. */
  readonly requestHeaders: Readonly<Record<string, string>>;
  /**
   * The GPU memory the loaded model tiles may hold. The tiles in view stay
   * whatever they cost. The ones left behind stay too, for a quick return,
   * until the total passes this budget, and then the longest unused go
   * first.
   */
  readonly memoryBudgetInBytes: number;
  /** The byte quota of the model tiles kept on disk, where a tile seen before comes back from without the network. */
  readonly diskCacheSizeInBytes: number;
  /**
   * How much nearer in depth than it stands a model is drawn, as a share of
   * its distance from the camera, by the camera zoom: 0.05 draws a model two
   * kilometres away as if it were a hundred metres closer. Its place on the
   * screen does not change, only what it covers and is covered by.
   *
   * It puts a model over the map's own building it stands in for where the
   * map could not leave that building out, as in the map tiles whose
   * buildings are merged into groups: the building reaches a little out of
   * the model, by less than the bias takes the model forward. A building
   * standing well in front of the model is nearer than that and still covers
   * it. The cost of a larger share is a model showing over a neighbour that
   * stands right before it, a tree in front of a wall among them. Zero draws
   * a model where it stands. The default is 0.05 at zoom 14, the models'
   * zoom, falling to 0.01 by zoom 15.5, where the tiles carry every building
   * apart and the map leaves the ones the models stand in for out
   * (`defaultModelDepthBias`). Every stop is kept within
   * 0...`maximumModelDepthBias`. Applies live.
   */
  readonly depthBias: ImmersiveMapZoomCurve;
  /**
   * The camera zoom the models draw from. Below it they are not drawn and
   * stand in for no building, and reaching it they rise out of the ground
   * (`ExtrusionSettings.riseSeconds`). The model tiles are of zoom 14, so a
   * zoom below that draws none whatever this says. 14 by default.
   */
  readonly minimumZoom: number;
}

export const defaultModelArchiveSettings: ModelArchiveSettings = deepFreeze({
  archiveURL: null,
  requestHeaders: {},
  memoryBudgetInBytes: defaultModelMemoryBudgetInBytes,
  diskCacheSizeInBytes: defaultModelDiskCacheSizeInBytes,
  depthBias: defaultModelDepthBias,
  minimumZoom: 14,
});

/** `base` with the fields given set in place, the depth bias kept within its range. */
export function withModelArchiveOptions(
  base: ModelArchiveSettings,
  options: Options<ModelArchiveSettings, "depthBias">,
): ModelArchiveSettings {
  return deepFreeze(mergeOptions(base, options, { depthBias: clampedModelDepthBias }));
}

export function modelArchiveSettings(options: Options<ModelArchiveSettings, "depthBias"> = {}): ModelArchiveSettings {
  return withModelArchiveOptions(defaultModelArchiveSettings, options);
}

/** The bias at a camera zoom, within its range. */
export function modelDepthBias(archive: ModelArchiveSettings, zoom: number): number {
  return clampedDepthBiasValue(zoomCurveValue(archive.depthBias, zoom));
}

/**
 * Whether two model archive settings differ in the bias alone: what tells a
 * change of the bias, applied live, from a change of the archive, which
 * rebuilds the renderer (`planSettingsApplication`).
 */
export function modelArchivesDifferInDepthBiasAlone(a: ModelArchiveSettings, b: ModelArchiveSettings): boolean {
  return deepEqual({ ...a, depthBias: b.depthBias }, b);
}
