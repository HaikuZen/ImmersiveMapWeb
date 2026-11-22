// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import { withTerrainSurroundings } from "../../configuration/tile-settings.ts";
import type { TerrainSurroundingsSettings } from "../../configuration/tile-settings.ts";
import { formatFixed, swiftRounded } from "./debug-overlay-geometry.ts";

/**
 * The Relief tab's Surroundings group: the ranges and titles of the sliders
 * that tune how the country around the camera is read as mountains or a
 * plain (the Swift `DebugOverlayTerrainSurroundingsSettingsPlanner`). The
 * panel edits `TerrainSurroundingsSettings` live and shows the reading in
 * the tab's summary.
 */
export const DebugOverlayTerrainSurroundingsSettingsPlanner = {
  /** From a hill's worth of ground to a whole range. */
  sampleRadiusRange: closedRange(250, 20000),
  /** The spans the thresholds are set among: the lowlands span under a hundred metres over a few kilometres, the high mountains thousands. */
  plainBelowRange: closedRange(0, 1500),
  mountainsAboveRange: closedRange(0, 3000),
  smoothingHalfLifeRange: closedRange(0, 3),
  groupTitle: "Surroundings",

  sampleRadiusTitle(metres: number): string {
    return `Radius ${formatFixed(metres, 0)} m`;
  },

  plainBelowTitle(metres: number): string {
    return `Plain below ${formatFixed(metres, 0)} m`;
  },

  mountainsAboveTitle(metres: number): string {
    return `Mountains above ${formatFixed(metres, 0)} m`;
  },

  smoothingHalfLifeTitle(seconds: number): string {
    return `Smoothing ${formatFixed(seconds, 2)} s`;
  },

  /** The four sliders read as one, in round metres and hundredths of a second: a drag of any of them sends the group whole. */
  settings(
    current: TerrainSurroundingsSettings,
    sliders: {
      readonly sampleRadiusMetres: number;
      readonly plainBelowMetres: number;
      readonly mountainsAboveMetres: number;
      readonly smoothingHalfLife: number;
    },
  ): TerrainSurroundingsSettings {
    return withTerrainSurroundings(current, {
      sampleRadiusMetres: swiftRounded(sliders.sampleRadiusMetres),
      plainBelowMetres: swiftRounded(sliders.plainBelowMetres),
      mountainsAboveMetres: swiftRounded(sliders.mountainsAboveMetres),
      smoothingHalfLife: swiftRounded(sliders.smoothingHalfLife * 100) / 100,
    });
  },
} as const;
