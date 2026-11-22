// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `ImmersiveMapSettingsApplicationPlannerTests`, with the
// planner parts of `TransparentSpaceSettingsTests`, `RasterTileTests`,
// `GroundFogTests`, `BuildingExtrusionToggleTests` and `NightThemeTests`.

import { describe, expect, test } from "vitest";
import { applyTheme, defaultTheme, protomapsBasemapMapStyle } from "../style/theme.ts";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { defaultModelDepthBias, maximumModelDepthBias, modelArchiveSettings, modelDepthBias } from "./model-archive-settings.ts";
import { planSettingsApplication } from "./settings-application-planner.ts";
import type { ImmersiveMapSettingsApplyAction, ImmersiveMapSettingsChangeDomain } from "./settings-application-planner.ts";
import { ImmersiveMapTilesService } from "./tiles-service.ts";
import { zoomCurve } from "./zoom-curve.ts";

const settings = ImmersiveMapSettings.default;
const domains = (...values: ImmersiveMapSettingsChangeDomain[]) => new Set(values);
const actions = (...values: ImmersiveMapSettingsApplyAction[]) => new Set(values);

describe("planSettingsApplication", () => {
  /** The archive client, the disk cache and the memory budget are built with the renderer, and the map's own tiles do not depend on the models. */
  test("a model archive change recreates the renderer and keeps the tiles", () => {
    const next = settings.modelArchive("https://tiles.example.com/models.pmtiles");
    const plan = planSettingsApplication(settings, next);
    expect(plan.changedDomains).toEqual(domains("modelArchive"));
    expect(plan.actions).toEqual(actions("recreateRenderer"));

    const resized = next.edit((draft) => {
      draft.modelArchive.memoryBudgetInBytes = 32 * 1024 * 1024;
    });
    expect(planSettingsApplication(next, resized).actions).toEqual(actions("recreateRenderer"));
    expect(planSettingsApplication(next, next).actions.size).toBe(0);
  });

  /** The modifier names the source alone and keeps how the models load and draw, set before it or after. */
  test("the model archive modifier keeps the budgets", () => {
    const value = settings
      .modelArchiveSettings(
        modelArchiveSettings({ archiveURL: "https://tiles.example.com/a.pmtiles", memoryBudgetInBytes: 1000, diskCacheSizeInBytes: 2000 }),
      )
      .modelArchive("https://tiles.example.com/b.pmtiles", { Authorization: "Bearer x" });
    expect(value.data.modelArchive.archiveURL?.endsWith("/b.pmtiles")).toBe(true);
    expect(value.data.modelArchive.requestHeaders).toEqual({ Authorization: "Bearer x" });
    expect(value.data.modelArchive.memoryBudgetInBytes).toBe(1000);
    expect(value.data.modelArchive.diskCacheSizeInBytes).toBe(2000);
    // The web port draws no models unless the app names an archive.
    expect(settings.data.modelArchive.archiveURL).toBeNull();
    expect(value.modelArchive(null).data.modelArchive.archiveURL).toBeNull();

    const tunedFirst = settings
      .modelArchiveSettings({ depthBias: 0.02, minimumZoom: 15 })
      .modelArchive("https://tiles.example.com/b.pmtiles");
    expect(tunedFirst.data.modelArchive.depthBias).toEqual(zoomCurve(0.02));
    expect(tunedFirst.data.modelArchive.minimumZoom).toBe(15);
    expect(settings.modelArchive(ImmersiveMapTilesService.modelArchiveURL).modelArchive(null).data.modelArchive).toEqual(modelArchiveSettings());
    expect(settings.modelArchive(ImmersiveMapTilesService.modelArchiveURL).data.modelArchive.archiveURL).toBe(ImmersiveMapTilesService.modelArchiveURL);
  });

  /** Hiding the controls hides views over the map: nothing is rebuilt, and the debug panel stays enabled. */
  test("hiding the controls is live applied", () => {
    const shown = settings.debugPanel();
    expect(shown.controls.isHidden).toBe(false);
    const hidden = shown.controlsHidden();
    expect(hidden.debug.enableDebugPanel).toBe(true);
    const plan = planSettingsApplication(shown, hidden);
    expect(plan.changedDomains).toEqual(domains("controls"));
    expect(plan.actions).toEqual(actions("liveApply"));
  });

  test("a scene light direction change is live applied", () => {
    const plan = planSettingsApplication(settings, settings.sceneLight({ direction: [0.5, -0.3, 1.0] }));
    expect(plan.changedDomains).toEqual(domains("scene"));
    expect(plan.actions).toEqual(actions("liveApply"));
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  test("a shadow settings change is live applied", () => {
    const next = settings.shadows({ isEnabled: false }).edit((draft) => {
      draft.scene.shadows.mapResolution = 512;
    });
    const plan = planSettingsApplication(settings, next);
    expect(plan.changedDomains).toEqual(domains("scene"));
    expect(plan.actions).toEqual(actions("liveApply"));
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  /** The atmosphere is a per-frame uniform: switching it, or recolouring it, must not recreate the renderer. */
  test("an atmosphere settings change is live applied", () => {
    const next = settings.atmosphere({ isEnabled: false }).atmosphereSettings({ color: [1, 0.8, 0.6] });
    const plan = planSettingsApplication(settings, next);
    expect(plan.changedDomains).toEqual(domains("scene"));
    expect(plan.actions).toEqual(actions("liveApply"));
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  test("a post-processing FXAA change is live applied", () => {
    const plan = planSettingsApplication(settings, settings.fxaa());
    expect(plan.changedDomains).toEqual(domains("postProcessing"));
    expect(plan.actions).toEqual(actions("liveApply"));
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  test("a debug panel switch recreates the renderer for the tile status instrumentation", () => {
    const plan = planSettingsApplication(settings, settings.debugPanel());
    expect(plan.changedDomains).toEqual(domains("debug"));
    expect(plan.actions).toEqual(actions("recreateRenderer"));
    expect(plan.requiresRendererRecreation).toBe(true);
  });

  /** With labels off the parser bakes no text, so the switch is a prepared-data change like every other label field. */
  test("a labels switch rebuilds the prepared data", () => {
    const plan = planSettingsApplication(settings, settings.labels({ isEnabled: false }));
    expect(plan.changedDomains).toEqual(domains("labels"));
    expect(plan.actions).toEqual(actions("invalidateCaches", "rebuildPreparedData", "recreateRenderer"));
    expect(plan.requiresRendererRecreation).toBe(true);
  });

  test("a label fallback policy change rebuilds the prepared data", () => {
    const plan = planSettingsApplication(settings, settings.labelSettings({ fallbackPolicy: "localFirst" }));
    expect(plan.changedDomains).toEqual(domains("labels"));
    expect(plan.actions).toEqual(actions("invalidateCaches", "rebuildPreparedData", "recreateRenderer"));
  });

  /** The sample count is baked into every pipeline state, so switching MSAA rebuilds the GPU resources and the renderer. */
  test("a multisample count change recreates the renderer", () => {
    const next = settings.msaa();
    const plan = planSettingsApplication(settings, next);
    expect(plan.changedDomains).toEqual(domains("postProcessing"));
    expect(plan.actions).toEqual(actions("rebuildGPUResources", "recreateRenderer"));
    expect(plan.requiresRendererRecreation).toBe(true);
    expect(next.postProcessing.multisampleCount).toBe(4);
    expect(next.msaa({ isEnabled: false }).postProcessing.multisampleCount).toBe(1);
  });

  /** The globe switch is a per-frame input of the presentation resolver, so it applies live. */
  test("a globe switch is live applied", () => {
    const plan = planSettingsApplication(settings, settings.globe({ isEnabled: false }));
    expect(plan.changedDomains).toEqual(domains("presentation"));
    expect(plan.actions).toEqual(actions("liveApply"));
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  test("a map style label palette change rebuilds the prepared data", () => {
    const previous = settings.mapStyle(protomapsBasemapMapStyle(defaultTheme));
    const next = settings.mapStyle(
      protomapsBasemapMapStyle(
        applyTheme(defaultTheme, (theme) => {
          theme.labels.town.haloEm = 0.11;
        }),
      ),
    );
    const plan = planSettingsApplication(previous, next);
    expect(plan.changedDomains).toEqual(domains("style"));
    expect(plan.actions).toEqual(actions("invalidateCaches", "rebuildPreparedData", "rebuildGPUResources", "recreateRenderer"));
    expect(plan.requiresRendererRecreation).toBe(true);
  });

  /** The theme's values drawn at frame time are baked into nothing: a change of them applies live. */
  test("a change of the theme's frame-time values is live applied", () => {
    const next = settings.mapStyle(
      protomapsBasemapMapStyle(
        applyTheme(defaultTheme, (theme) => {
          theme.hillshade.intensity = 0.5;
          theme.labelOpacity.pois = { 14: 0.6, 16: 1 };
          theme.layers.trees.palette.trunkColor = [0, 0, 0];
        }),
      ),
    );
    const plan = planSettingsApplication(settings, next);
    expect(plan.changedDomains).toEqual(domains("style"));
    expect(plan.actions).toEqual(actions("liveApply"));
  });

  /** The depth bias of the models is a curve over the zoom whose every stop is kept within its range. */
  test("the model depth bias is kept within its range", () => {
    const url = "https://tiles.example.com/models.pmtiles";
    expect(modelArchiveSettings({ archiveURL: url }).depthBias).toEqual(defaultModelDepthBias);
    expect(modelArchiveSettings({ archiveURL: url, depthBias: -1 }).depthBias).toEqual(zoomCurve(0));
    expect(modelArchiveSettings({ archiveURL: url, depthBias: 3 }).depthBias).toEqual(zoomCurve(maximumModelDepthBias));
    expect(modelArchiveSettings({ archiveURL: url, depthBias: { 12: Number.NaN, 16: 9 } }).depthBias).toEqual(
      zoomCurve({ 12: 0, 16: maximumModelDepthBias }),
    );
    const edited = settings.edit((draft) => {
      draft.modelArchive.depthBias = { 0: 9 };
    });
    expect(edited.data.modelArchive.depthBias).toEqual(zoomCurve(maximumModelDepthBias));

    const kept = settings.modelArchive(url).modelArchiveSettings({ depthBias: 0.02 }).modelArchive(url);
    expect(kept.data.modelArchive.depthBias).toEqual(zoomCurve(0.02));
  });

  /** The default bias is there at the models' zoom and down to a trace from zoom 15.5. */
  test("the default model depth bias falls by zoom 15.5", () => {
    const archive = modelArchiveSettings({ archiveURL: "https://tiles.example.com/models.pmtiles" });
    expect(modelDepthBias(archive, 13)).toBe(0.05);
    expect(modelDepthBias(archive, 14)).toBe(0.05);
    expect(modelDepthBias(archive, 15.5)).toBe(0.01);
    expect(modelDepthBias(archive, 18)).toBe(0.01);
    expect(modelDepthBias(archive, 14.75)).toBeGreaterThan(0.01);
    expect(modelDepthBias(archive, 14.75)).toBeLessThan(0.05);
  });

  /** A change of the bias alone applies live. */
  test("a change of the model depth bias alone applies live", () => {
    const previous = settings.modelArchive("https://tiles.example.com/models.pmtiles");
    const plan = planSettingsApplication(previous, previous.modelArchiveSettings({ depthBias: { 14: 0.1, 16: 0 } }));
    expect(plan.changedDomains).toEqual(domains("modelArchive"));
    expect(plan.actions).toEqual(actions("liveApply"));
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  /** The transparent space is a per-frame uniform and a pass-plan flag. */
  test("switching the transparent space applies live", () => {
    const plan = planSettingsApplication(settings, settings.transparentSpace());
    expect(plan.changedDomains.has("scene")).toBe(true);
    expect(plan.requiresRendererRecreation).toBe(false);
  });

  /** The raster sampler is built with the renderer, and the prepared tiles do not depend on it. */
  test("a rasterization change recreates the renderer and keeps the caches", () => {
    const plan = planSettingsApplication(settings, settings.tileRasterization({ maximumAnisotropy: 4 }));
    expect(plan.requiresRendererRecreation).toBe(true);
    expect(plan.actions.has("invalidateCaches")).toBe(false);
    expect(plan.actions.has("rebuildPreparedData")).toBe(false);
  });

  test("a ground fog change applies live", () => {
    expect(planSettingsApplication(settings, settings.groundFog({ heightMeters: 40 })).actions).toEqual(actions("liveApply"));
  });

  test("a building extrusion switch in the theme is a heavy change", () => {
    const next = settings.mapStyle(
      protomapsBasemapMapStyle(
        applyTheme(defaultTheme, (theme) => {
          theme.features.buildingExtrusion = false;
        }),
      ),
    );
    const plan = planSettingsApplication(settings, next);
    expect(plan.actions.has("rebuildPreparedData")).toBe(true);
    expect(plan.actions.has("invalidateCaches")).toBe(true);
    expect(plan.requiresRendererRecreation).toBe(true);
  });

  /** The change of palette re-prepares the tiles, as any change of style, and the air applies live with it. */
  test("the night is a style change", () => {
    const plan = planSettingsApplication(settings, settings.night());
    expect(plan.changedDomains.has("style")).toBe(true);
    expect(plan.actions.has("rebuildPreparedData")).toBe(true);
  });

  test("the starfield and the pins rebuild the GPU resources", () => {
    const stars = settings.edit((draft) => {
      draft.scene.starfield.starCount = 10;
    });
    expect(planSettingsApplication(settings, stars).actions).toEqual(actions("rebuildGPUResources", "recreateRenderer"));
    expect(planSettingsApplication(settings, settings.pinSettings({ sizeScale: 2 })).actions).toEqual(
      actions("rebuildGPUResources", "recreateRenderer"),
    );
  });

  test("the network, the cache and the parse invalidate the caches", () => {
    expect(planSettingsApplication(settings, settings.tileArchive("https://tiles.example.com/a.pmtiles")).actions).toEqual(
      actions("invalidateCaches", "recreateRenderer"),
    );
    expect(planSettingsApplication(settings, settings.tileParsing({ maximumConcurrentParses: 2 })).actions).toEqual(
      actions("invalidateCaches", "rebuildPreparedData", "recreateRenderer"),
    );
  });
});
