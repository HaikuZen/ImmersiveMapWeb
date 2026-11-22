// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import { zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapLabelOpacity } from "../../style/theme.ts";
import { formatFixed } from "./debug-overlay-geometry.ts";
import { DebugOverlayZoomCurveAxes } from "./debug-overlay-zoom-curve-editing.ts";

/**
 * The Labels tab's opacity graphs (the Swift
 * `DebugOverlayLabelOpacitySettingsPlanner`). The panel drags the style's
 * curves (`ImmersiveMapLabelOpacity`) live over the style's own: the names'
 * and the POIs', each a factor 0 to 1 over every label's own opacity, by the
 * zoom, on a graph like the air's.
 */
export const DebugOverlayLabelOpacitySettingsPlanner = {
  /** A factor over the zoom, none to the label's own opacity. */
  opacityAxes: DebugOverlayZoomCurveAxes.of(closedRange(0, 22), closedRange(0, 1)),

  namesTitle(curve: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Names opacity ${DebugOverlayLabelOpacitySettingsPlanner.opacityText(zoomCurveValue(curve, cameraZoom))}`;
  },

  poisTitle(curve: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `POI opacity ${DebugOverlayLabelOpacitySettingsPlanner.opacityText(zoomCurveValue(curve, cameraZoom))}`;
  },

  /** The graphs' value text: two places. */
  opacityText(opacity: number): string {
    return formatFixed(opacity, 2);
  },

  /** A graph's edited curve, `names` or `pois`. */
  withCurve(opacity: ImmersiveMapLabelOpacity, field: keyof ImmersiveMapLabelOpacity, curve: ImmersiveMapZoomCurve): ImmersiveMapLabelOpacity {
    return { ...opacity, [field]: curve };
  },
} as const;
