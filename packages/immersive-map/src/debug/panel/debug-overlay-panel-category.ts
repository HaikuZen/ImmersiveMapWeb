// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { DebugOverlayHUDContentRequest } from "../../render/debug/debug-overlay-hud-snapshot-store.ts";

/**
 * The tabs along the top of the debug panel (the Swift
 * `DebugOverlayPanelCategory`): each shows the groups of one category, and
 * `all` shows every group at once, the way the panel was before it had
 * tabs, for the debugging that watches two groups together (the stats while
 * a control is toggled).
 *
 * `light` is the sun's direction in the sky. `shadows` is the shadow map's
 * settings, with the hillshade and the mountains' shadows as a group of its
 * own. `occlusion` is the occlusion of the sky by the terrain
 * (`ImmersiveMapTerrainOcclusion`). `globe` is the sun on the globe
 * (`GlobeLightSettings`). `air` is the air over the flat map, the ground
 * fog's curves and its heights on the relief (`GroundFogSettings`).
 * `buildingModels` is the depth bias of the buildings' models from the
 * model archive (`ModelArchiveSettings.depthBias`), which nothing else has.
 */
export type DebugOverlayPanelCategory =
  | "all"
  | "stats"
  | "labels"
  | "light"
  | "shadows"
  | "occlusion"
  | "sky"
  | "globe"
  | "air"
  | "map"
  | "buildingModels"
  | "tiles"
  | "relief"
  | "export";

const titles: Readonly<Record<DebugOverlayPanelCategory, string>> = Object.freeze({
  all: "All",
  stats: "Stats",
  labels: "Labels",
  light: "Light",
  shadows: "Shadows",
  occlusion: "AO",
  sky: "Sky",
  globe: "Globe",
  air: "Air",
  map: "Map",
  buildingModels: "3D buildings",
  tiles: "Tiles",
  relief: "Relief",
  export: "Export",
});

export const DebugOverlayPanelCategory = {
  /** Every tab in the order the tab strip shows them (Swift's `allCases`). */
  allCases: Object.freeze([
    "all",
    "stats",
    "labels",
    "light",
    "shadows",
    "occlusion",
    "sky",
    "globe",
    "air",
    "map",
    "buildingModels",
    "tiles",
    "relief",
    "export",
  ]) as readonly DebugOverlayPanelCategory[],

  /** The tab's title on the strip. */
  title(category: DebugOverlayPanelCategory): string {
    return titles[category];
  },

  /** Whether the panel, on the tab `selected`, shows the groups of `category`. */
  shows(selected: DebugOverlayPanelCategory, category: DebugOverlayPanelCategory): boolean {
    return selected === "all" || selected === category;
  },

  /**
   * The content the tab shows, for the frame to build only that
   * (`DebugOverlayHUDSnapshotStore.requestedContent`): the tabs of settings
   * read no frame data at all, the AO tab reads the relief's status for
   * its computing line.
   */
  shownContent(selected: DebugOverlayPanelCategory): DebugOverlayHUDContentRequest {
    switch (selected) {
      case "all":
        return DebugOverlayHUDContentRequest.all;
      case "stats":
        return DebugOverlayHUDContentRequest.stats;
      case "tiles":
        return DebugOverlayHUDContentRequest.tiles;
      case "relief":
      case "occlusion":
        return DebugOverlayHUDContentRequest.relief;
      default:
        return DebugOverlayHUDContentRequest.none;
    }
  },
} as const;
