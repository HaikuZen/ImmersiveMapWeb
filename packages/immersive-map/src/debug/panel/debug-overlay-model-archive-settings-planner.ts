// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import { clampedModelDepthBias, defaultModelDepthBias, maximumModelDepthBias } from "../../configuration/model-archive-settings.ts";
import type { ModelArchiveSettings } from "../../configuration/model-archive-settings.ts";
import { zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import { formatFixed } from "./debug-overlay-geometry.ts";
import { DebugOverlayZoomCurveAxes } from "./debug-overlay-zoom-curve-editing.ts";

const depthBiasAxes = DebugOverlayZoomCurveAxes.of(closedRange(0, 22), closedRange(0, maximumModelDepthBias));

/**
 * The 3D buildings tab's graph axes and titles (the Swift
 * `DebugOverlayModelArchiveSettingsPlanner`). The panel edits the depth bias
 * of the buildings' models from the model archive
 * (`ModelArchiveSettings.depthBias`) live, on a graph over the zoom like the
 * air's. Nothing else has such a bias. A map without an archive shows
 * `absentTitle` in place of the graph.
 */
export const DebugOverlayModelArchiveSettingsPlanner = {
  /** The bias over the zoom, zero to the setting's own ceiling. */
  depthBiasAxes,
  groupTitle: "3D building models",
  absentTitle: "No model archive on this map",

  depthBiasTitle(depthBias: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return DebugOverlayModelArchiveSettingsPlanner.depthBiasText(zoomCurveValue(depthBias, cameraZoom, depthBiasAxes.interpolation));
  },

  depthBiasText(depthBias: number): string {
    return `Depth bias ${formatFixed(depthBias, 3)}`;
  },

  /** The bias the panel shows: the archive's, `undefined` on a map without one. */
  depthBias(archive: ModelArchiveSettings): ImmersiveMapZoomCurve | undefined {
    return archive.archiveURL === null ? undefined : archive.depthBias;
  },

  /** The curve the graph draws: the archive's bias, or the default faintly on a map without an archive (the graph then disabled). */
  displayedDepthBias(depthBias: ImmersiveMapZoomCurve | undefined): ImmersiveMapZoomCurve {
    return depthBias ?? defaultModelDepthBias;
  },

  /** The graph's edited curve, held under the ceiling as the settings hold it. */
  edited(curve: ImmersiveMapZoomCurve): ImmersiveMapZoomCurve {
    return clampedModelDepthBias(curve);
  },
} as const;
