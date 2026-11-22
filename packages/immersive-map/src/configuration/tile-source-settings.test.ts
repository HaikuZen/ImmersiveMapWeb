// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `TileSourceAndStyleSettingsTests`,
// `TileMaximumZoomLevelSettingsTests` and `ImmersiveMapTileSourceSettingsTests`.

import { describe, expect, test } from "vitest";
import { applyTheme, defaultTheme, protomapsBasemapMapStyle } from "../style/theme.ts";
import { ImmersiveMapByteCount } from "./byte-count.ts";
import { cameraSettings, globeBearingLimit } from "./camera-settings.ts";
import { ImmersiveMapAttribution } from "./attribution.ts";
import { attributionSettings } from "./attribution-settings.ts";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { pinSizes } from "./pin-settings.ts";
import { presentationSettings } from "./presentation-settings.ts";
import { planSettingsApplication } from "./settings-application-planner.ts";
import { coverageSettings, defaultPreparedDiskCacheSizeInBytes, resolvedMaximumZoomLevel } from "./tile-settings.ts";
import { ImmersiveMapTilesService } from "./tiles-service.ts";
import { debugSettings, postProcessingSettings, renderLoopSettings } from "./view-settings.ts";

const settings = ImmersiveMapSettings.default;

describe("the tile source and the style", () => {
  test("the archive and the map style configure the source and the style separately", () => {
    const theme = applyTheme(defaultTheme, (draft) => {
      draft.labels.town.haloEm = 0.125;
    });
    const value = settings.tileArchive("https://tiles.example.com/planet.pmtiles").mapStyle(protomapsBasemapMapStyle(theme));
    expect(value.tiles.network.tileArchiveURL).toBe("https://tiles.example.com/planet.pmtiles");
    expect(value.data.mapStyle).toEqual(protomapsBasemapMapStyle(theme));
    expect(value.tiles.coverage.maximumZoomLevel).toBeNull();
  });

  test("the default settings point at the hosted service", () => {
    const network = settings.tiles.network;
    expect(network.tileArchiveURL).toBe(ImmersiveMapTilesService.tileArchiveURL);
    expect(network.tileArchiveURL.endsWith(".pmtiles")).toBe(true);
    expect(network.tileRequestHeaders).toEqual({});
  });

  test("a map style change rebuilds the prepared data", () => {
    const previous = settings.mapStyle(protomapsBasemapMapStyle(defaultTheme));
    const next = settings.mapStyle(
      protomapsBasemapMapStyle(
        applyTheme(defaultTheme, (draft) => {
          draft.layers.water = [0.12, 0.34, 0.56, 1.0];
        }),
      ),
    );
    const plan = planSettingsApplication(previous, next);
    expect(plan.changedDomains).toEqual(new Set(["style"]));
    expect(plan.actions).toEqual(new Set(["invalidateCaches", "rebuildPreparedData", "rebuildGPUResources", "recreateRenderer"]));
    expect(plan.requiresRendererRecreation).toBe(true);
  });

  /** The overview is laid into the tiles by the load pipeline and baked into the prepared tiles: switching it rebuilds both. */
  test("an overview switch rebuilds the pipeline and the prepared data", () => {
    expect(settings.tiles.overview.isEnabled).toBe(true);
    const plan = planSettingsApplication(settings, settings.overviewTiles({ isEnabled: false }));
    expect(plan.changedDomains).toEqual(new Set(["tiles", "attribution"]));
    expect(plan.actions).toEqual(new Set(["invalidateCaches", "rebuildPreparedData", "recreateRenderer", "liveApply"]));
    expect(plan.requiresRendererRecreation).toBe(true);
  });
});

describe("the tile maximum zoom level", () => {
  /** A map states nothing about the depth: no cap, and until the archive's header was read, the hosted archive's depth. */
  test("by default the archive decides", () => {
    const coverage = settings.tiles.coverage;
    expect(coverage.maximumZoomLevel).toBeNull();
    expect(coverage.archiveMaximumZoomLevel).toBeNull();
    expect(resolvedMaximumZoomLevel(coverage)).toBe(ImmersiveMapTilesService.maximumTileZoomLevel);
  });

  /** The archive's depth, under the cap when there is one, and the cap alone while the depth is unknown. */
  test("the depth is the archive's under the cap", () => {
    const resolved = (cap: number | null, archive: number | null) =>
      resolvedMaximumZoomLevel(coverageSettings({ maximumZoomLevel: cap, archiveMaximumZoomLevel: archive }));
    expect(resolved(null, 14)).toBe(14);
    expect(resolved(null, 16)).toBe(16);
    expect(resolved(13, 16)).toBe(13);
    expect(resolved(18, 14)).toBe(14);
    expect(resolved(13, null)).toBe(13);
  });

  test("the modifier sets and clears the cap", () => {
    const capped = settings.tileMaximumZoomLevel(14);
    expect(capped.tiles.coverage.maximumZoomLevel).toBe(14);
    expect(capped.tileMaximumZoomLevel(null).tiles.coverage.maximumZoomLevel).toBeNull();
  });

  /** The settings a map is built from carry the depth kept for their archive, and a change of it rebuilds the renderer. */
  test("the settings carry the kept depth and a change rebuilds", () => {
    const value = settings.tileArchive("https://tiles.example.com/planet.pmtiles");
    expect(value.resolvingArchiveDepth(null).tiles.coverage.archiveMaximumZoomLevel).toBeNull();
    const resolved = value.resolvingArchiveDepth(14);
    expect(resolvedMaximumZoomLevel(resolved.tiles.coverage)).toBe(14);
    expect(planSettingsApplication(value, resolved).requiresRendererRecreation).toBe(true);
    const margin = planSettingsApplication(resolved, resolved.tileCoverage({ rasterBandMarginShare: 0.5 }));
    expect(margin.actions).toEqual(new Set(["liveApply"]));
  });
});

describe("the tile source settings", () => {
  test("the debug panel enables the debug overlay", () => {
    expect(settings.debugPanel().debug.enableDebugPanel).toBe(true);
    expect(settings.debugPanel(true, { zoomBadge: false }).debug.showsZoomBadge).toBe(false);
  });

  test("the map style modifier stores the built-in configuration", () => {
    const style = protomapsBasemapMapStyle(
      applyTheme(defaultTheme, (draft) => {
        draft.labels.town.haloEm = 0.125;
      }),
    );
    const value = settings.mapStyle(style);
    expect(value.data.mapStyle).toEqual(style);
    expect(value.equals(settings)).toBe(false);
  });

  test("the tile archive modifier stores the archive URL and the headers", () => {
    const value = settings.tileArchive("https://tiles.com/planet.pmtiles?apiKey=xxx", { "X-Client": "demo" });
    expect(value.tiles.network.tileArchiveURL).toBe("https://tiles.com/planet.pmtiles?apiKey=xxx");
    expect(value.tiles.network.tileRequestHeaders).toEqual({ "X-Client": "demo" });
  });

  test("the cache modifier updates only the provided cache values", () => {
    const baseTiles = settings.edit((draft) => {
      draft.tiles.network.maxConcurrentFetches = 11;
      draft.tiles.network.pendingRequestQueueCapacity = 27;
      draft.tiles.parsing.addTestBorders = true;
      draft.tiles.cache.clearDiskCachesOnLaunch = false;
      draft.tiles.cache.preparedDiskTimeToLive = 34;
      draft.tiles.cache.preparedDiskCacheSizeInBytes = 45;
    }).tiles;
    const value = settings.tileSettings(baseTiles).tileSettings({
      clearDiskCachesOnLaunch: true,
      preparedDiskTimeToLive: 78,
      preparedDiskCacheSizeInBytes: 89,
    });
    expect(value.tiles.network).toEqual(baseTiles.network);
    expect(value.tiles.parsing).toEqual(baseTiles.parsing);
    expect(value.tiles.coverage).toEqual(baseTiles.coverage);
    expect(value.tiles.cache.clearDiskCachesOnLaunch).toBe(true);
    expect(value.tiles.cache.preparedDiskTimeToLive).toBe(78);
    expect(value.tiles.cache.preparedDiskCacheSizeInBytes).toBe(89);
    expect(settings.tiles.cache.preparedDiskCacheSizeInBytes).toBe(defaultPreparedDiskCacheSizeInBytes);
    expect(settings.tileSettings({ clearDiskCachesOnLaunch: true, preparedDiskCacheSizeInBytes: 64 }).tiles.cache).toMatchObject({
      clearDiskCachesOnLaunch: true,
      preparedDiskCacheSizeInBytes: 64,
      preparedDiskTimeToLive: settings.tiles.cache.preparedDiskTimeToLive,
    });
  });

  /** The number itself is the contract: the prepared disk cache is the layer revisits come back from. */
  test("the prepared disk cache default is two gibibytes", () => {
    expect(defaultPreparedDiskCacheSizeInBytes).toBe(2_147_483_648);
    expect(settings.tiles.cache.preparedDiskCacheSizeInBytes).toBe(2_147_483_648);
  });

  test("the prepared tile disk cache size modifier writes the cache field", () => {
    const value = settings.preparedTileDiskCacheSize(ImmersiveMapByteCount.gigabytes(4));
    expect(value.tiles.cache.preparedDiskCacheSizeInBytes).toBe(4_294_967_296);
    expect(value.tiles.cache.preparedDiskTimeToLive).toBe(settings.tiles.cache.preparedDiskTimeToLive);
    expect(settings.preparedTileDiskCacheSize(ImmersiveMapByteCount.megabytes(512)).tiles.cache.preparedDiskCacheSizeInBytes).toBe(
      536_870_912,
    );
  });

  /** A size is written in the unit that reads best, a gigabyte 1024 megabytes, and a negative one is zero. */
  test("a byte count reads in its unit", () => {
    expect(ImmersiveMapByteCount.gigabytes(2).bytes).toBe(2_147_483_648);
    expect(ImmersiveMapByteCount.gigabytes(2).bytes).toBe(defaultPreparedDiskCacheSizeInBytes);
    expect(ImmersiveMapByteCount.megabytes(1.5).bytes).toBe(1_572_864);
    expect(ImmersiveMapByteCount.kilobytes(1).bytes).toBe(1024);
    expect(ImmersiveMapByteCount.bytes(-5).bytes).toBe(0);
    expect(ImmersiveMapByteCount.megabytes(-1).bytes).toBe(0);
    expect(ImmersiveMapByteCount.compare(ImmersiveMapByteCount.megabytes(1023), ImmersiveMapByteCount.gigabytes(1))).toBeLessThan(0);
  });

  test("the pin settings modifier updates only the provided pin values", () => {
    const pins = settings.pinSettings({ size: 128, sizeScale: 2, borderWidthPx: 4 }).pins;
    expect(pins.size).toBe(128);
    expect(pins.sizeScale).toBe(2);
    expect(pins.borderWidthPx).toBe(4);
    expect(pins.compressedScale).toBe(settings.pins.compressedScale);
    expect(pins.groupingThreshold).toBe(settings.pins.groupingThreshold);
    expect(pins.collisionPaddingPx).toBe(settings.pins.collisionPaddingPx);
  });

  test("the pin sizes support a large texture grid", () => {
    expect(pinSizes).toEqual([64, 128, 256, 512, 1024, 2048]);
  });

  test("the group modifiers replace every settings domain", () => {
    const renderLoop = renderLoopSettings({ forceContinuousRendering: true, interactionFramesPerSecond: 30, labelFadeFramesPerSecond: 15 });
    const camera = cameraSettings({
      maximumPitch: 1,
      maximumZoom: 17,
      focusedMarkerZoom: 14,
      globeBearingLimit: globeBearingLimit(0.5, 4),
      gesturePanTranslationScale: 1,
      worldPanSensitivity: 2,
      worldPanSpeed: 3,
      pinchZoomFactor: 4,
      pinchZoomVelocityFactor: 5,
      pinchZoomVelocityLimit: 6,
      dragZoomFactor: 7,
      dragZoomVelocityFactor: 8,
      dragZoomVelocityLimit: 9,
      rotationGestureSensitivity: 10,
    });
    const presentation = presentationSettings({ automaticTransitionStartZoom: 1, automaticTransitionSpan: 2, globeRadiusScale: 3 });
    const attribution = attributionSettings({
      isVisible: false,
      size: "large",
      position: "topLeading",
      textColor: [1, 0, 0, 1],
      isProvidedExternally: true,
      attributionOverride: ImmersiveMapAttribution.make([ImmersiveMapAttribution.credit("Tiles"), ImmersiveMapAttribution.credit("Copyright")]),
    });
    const postProcessing = postProcessingSettings({ fxaaEnabled: true });
    const debug = debugSettings({
      enableDebugPanel: true,
      coordinateScale: 1,
      diagnosticsScale: 2,
      leftPadding: 3,
      topPadding: 4,
      sectionSpacing: 5,
      textColor: [6, 7, 8],
    });

    const value = settings
      .renderLoopSettings(renderLoop)
      .cameraSettings(camera)
      .presentationSettings(presentation)
      .tileSettings(settings.tiles)
      .labelSettings(settings.data.labels)
      .sceneSettings(settings.scene)
      .pinSettings(settings.pins)
      .attributionSettings(attribution)
      .postProcessingSettings(postProcessing)
      .debugSettings(debug);

    expect(value.renderLoop).toEqual(renderLoop);
    expect(value.camera).toEqual(camera);
    expect(value.presentation).toEqual(presentation);
    expect(value.tiles).toEqual(settings.tiles);
    expect(value.data.labels).toEqual(settings.data.labels);
    expect(value.scene).toEqual(settings.scene);
    expect(value.pins).toEqual(settings.pins);
    expect(value.attribution).toEqual(attribution);
    expect(value.postProcessing).toEqual(postProcessing);
    expect(value.debug).toEqual(debug);
  });

  test("the archive with headers configures the source and the credentials together", () => {
    const value = settings.tileArchive("https://tiles.example.com/vector/planet.pmtiles", { Authorization: "Bearer public-token" });
    expect(value.tiles.network.tileArchiveURL).toBe("https://tiles.example.com/vector/planet.pmtiles");
    expect(value.tiles.network.tileRequestHeaders).toEqual({ Authorization: "Bearer public-token" });
  });
});
