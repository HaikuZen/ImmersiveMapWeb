// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { DebugOverlayRect, DebugOverlaySize } from "./debug-overlay-geometry.ts";
import { formatFixed, rectMaxX } from "./debug-overlay-geometry.ts";

/**
 * The zoom badge in the map's top trailing corner, a part of the debug panel
 * (`DebugSettings.showsZoomBadge`, the Swift `DebugOverlayZoomBadge`): the
 * camera's zoom and the planning zoom, large enough to read at a glance
 * while a gesture is under way. Over the relief the two part through a drag.
 * Read off the panel's frame snapshot, so it costs the frame nothing of its
 * own, and hidden with the panel and the map's controls. Pointer events go
 * through it to the map. The text is white, monospaced, semibold and right
 * aligned on a black plate.
 */
export const DebugOverlayZoomBadge = {
  fontSize: 22,
  lineSpacing: 2,
  horizontalPadding: 12,
  verticalPadding: 6,
  cornerRadius: 8,
  backgroundAlpha: 0.55,
  /** The distance from the map's top and trailing edges. */
  margin: 16,

  /** The badge's lines: the camera's zoom, then the planning zoom, to two places. */
  lines(zoom: number, planningZoom: number): [string, string] {
    return [`z ${formatFixed(zoom, 2)}`, `plan ${formatFixed(planningZoom, 2)}`];
  },

  /** The badge's size for its text's: the padding added round it. */
  size(textSize: DebugOverlaySize): DebugOverlaySize {
    const badge = DebugOverlayZoomBadge;
    return {
      width: Math.ceil(textSize.width) + badge.horizontalPadding * 2,
      height: Math.ceil(textSize.height) + badge.verticalPadding * 2,
    };
  },

  /** The badge's frame for its size, in the top trailing corner of `bounds` under `topInset`, in the leading one for a right-to-left layout. */
  frame(size: DebugOverlaySize, bounds: DebugOverlayRect, topInset: number, isRightToLeft: boolean): DebugOverlayRect {
    const margin = DebugOverlayZoomBadge.margin;
    const x = isRightToLeft ? bounds.x + margin : rectMaxX(bounds) - margin - size.width;
    return { x, y: bounds.y + topInset + margin, width: size.width, height: size.height };
  },
} as const;
