// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../../camera/view-mode.ts";

/** The zoom a frame's coverage targets. */
export interface TileCoverageZoomPlan {
  readonly baseZoom: number;
}

export const TileCoverageZoomPolicy = {
  /**
   * The target zoom: the camera zoom's whole part, within the tileset's
   * zooms. One zoom on both surfaces: the ring rules step it down by
   * distance, nothing requests ahead of it.
   */
  resolve(cameraZoom: number, _renderSurfaceMode: ViewMode, maximumZoomLevel: number): TileCoverageZoomPlan {
    return { baseZoom: Math.min(Math.max(0, Math.trunc(cameraZoom)), maximumZoomLevel) };
  },
} as const;
