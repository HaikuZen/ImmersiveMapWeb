// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vector3 } from "../../configuration/color.ts";
import { deepEqual } from "../../configuration/deep.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import type { AtmosphereSettings, FogSettings, GlobeLightSettings, GroundFogSettings, SceneSettings, ShadowSettings } from "../../configuration/scene-settings.ts";
import type { TerrainSurroundingsSettings } from "../../configuration/tile-settings.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";

/**
 * What the debug panel has been dragged to, kept apart from the settings the
 * app supplies (the Swift `DebugOverlaySettingsOverride`).
 *
 * The app hands the map its own settings again whenever it likes, and
 * without this a control in the panel reverted the moment it did, so
 * dragging one felt like it did nothing at all. The panel's values ride on
 * top of every incoming settings value instead, and a drag holds until it is
 * dragged somewhere else. A field left `undefined` is not dragged.
 *
 * The override is scoped to the debug panel being on: turning it off drops
 * the values (`retained`), and the app's own settings come straight back.
 */
export interface DebugOverlaySettingsOverride {
  readonly shadows?: ShadowSettings | undefined;
  readonly sunDirection?: Vector3 | undefined;
  readonly fog?: FogSettings | undefined;
  readonly atmosphere?: AtmosphereSettings | undefined;
  readonly globeLight?: GlobeLightSettings | undefined;
  readonly groundFog?: GroundFogSettings | undefined;
  /** The air over the mountains, itself optional: `null` is the panel having switched it off, `undefined` no drag. */
  readonly mountainGroundFog?: GroundFogSettings | null | undefined;
  readonly terrainSurroundings?: TerrainSurroundingsSettings | undefined;
  /** The models' depth bias, for a map with a model archive. */
  readonly modelDepthBias?: ImmersiveMapZoomCurve | undefined;
}

/** The air the app itself runs with, kept for the Air group's reset (the Swift runtime's `appGroundFog` and `appMountainGroundFog`). */
export interface DebugOverlayAppGroundFog {
  readonly groundFog: GroundFogSettings;
  readonly mountainGroundFog: GroundFogSettings | null;
}

const empty: DebugOverlaySettingsOverride = Object.freeze({});

export const DebugOverlaySettingsOverride = {
  /** No drag at all. */
  empty,

  isEmpty(override: DebugOverlaySettingsOverride): boolean {
    return (
      override.shadows === undefined &&
      override.sunDirection === undefined &&
      override.fog === undefined &&
      override.atmosphere === undefined &&
      override.globeLight === undefined &&
      override.groundFog === undefined &&
      override.mountainGroundFog === undefined &&
      override.terrainSurroundings === undefined &&
      override.modelDepthBias === undefined
    );
  },

  /**
   * The settings with every dragged group on top. With the panel off, or
   * nothing dragged, the settings as they are.
   */
  applied(override: DebugOverlaySettingsOverride, settings: ImmersiveMapSettings): ImmersiveMapSettings {
    if (!settings.debug.enableDebugPanel || DebugOverlaySettingsOverride.isEmpty(override)) {
      return settings;
    }
    const data = settings.data;
    let scene: SceneSettings = data.scene;
    if (override.shadows !== undefined) scene = { ...scene, shadows: override.shadows };
    if (override.sunDirection !== undefined) scene = { ...scene, light: { ...scene.light, direction: override.sunDirection } };
    if (override.fog !== undefined) scene = { ...scene, fog: override.fog };
    if (override.atmosphere !== undefined) scene = { ...scene, atmosphere: override.atmosphere };
    if (override.globeLight !== undefined) scene = { ...scene, globeLight: override.globeLight };
    if (override.groundFog !== undefined) scene = { ...scene, groundFog: override.groundFog };
    if (override.mountainGroundFog !== undefined) scene = { ...scene, mountainGroundFog: override.mountainGroundFog };
    let tiles = data.tiles;
    if (override.terrainSurroundings !== undefined) {
      tiles = { ...tiles, groundRelief: { ...tiles.groundRelief, surroundings: override.terrainSurroundings } };
    }
    let modelArchive = data.modelArchive;
    if (override.modelDepthBias !== undefined) modelArchive = { ...modelArchive, depthBias: override.modelDepthBias };
    return new ImmersiveMapSettings({ ...data, scene, tiles, modelArchive });
  },

  /** The override the panel keeps for incoming settings: everything while the panel is on, nothing once it is off. */
  retained(override: DebugOverlaySettingsOverride, settings: ImmersiveMapSettings): DebugOverlaySettingsOverride {
    return settings.debug.enableDebugPanel ? override : empty;
  },

  /**
   * The app's own air after incoming settings: settings whose air is not
   * the panel's drag carry the app's, and settings that carry the drag (the
   * panel's own request) leave what was known.
   */
  appGroundFog(
    previous: DebugOverlayAppGroundFog | undefined,
    override: DebugOverlaySettingsOverride,
    incoming: ImmersiveMapSettings,
  ): DebugOverlayAppGroundFog | undefined {
    if (override.groundFog !== undefined && deepEqual(override.groundFog, incoming.scene.groundFog)) return previous;
    return { groundFog: incoming.scene.groundFog, mountainGroundFog: incoming.scene.mountainGroundFog };
  },

  /**
   * The Air group's reset: both airs' drags dropped, and the settings with
   * the app's own airs back where they are known.
   */
  resettingGroundFog(
    override: DebugOverlaySettingsOverride,
    settings: ImmersiveMapSettings,
    app: DebugOverlayAppGroundFog | undefined,
  ): { readonly override: DebugOverlaySettingsOverride; readonly settings: ImmersiveMapSettings } {
    const cleared = { ...override, groundFog: undefined, mountainGroundFog: undefined };
    if (app === undefined) return { override: cleared, settings };
    const scene = { ...settings.scene, groundFog: app.groundFog, mountainGroundFog: app.mountainGroundFog };
    return { override: cleared, settings: new ImmersiveMapSettings({ ...settings.data, scene }) };
  },
} as const;
