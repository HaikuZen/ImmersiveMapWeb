// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb } from "../../configuration/color.ts";
import type { LabelOpacityFrame } from "../../style/theme.ts";
import type { PreparedLabelTextStyle } from "../../tile/store/prepared-labels.ts";

/**
 * The colour a label wears at a point of the globe's handover to the plane
 * (the Swift `LabelTextStyle.fillColor(atHandover:)`): the globe's at 0, the
 * label's own at 1 and wherever it states no globe colour, mixed between.
 */
export function colorAtHandover(sphere: Rgb | null, own: Rgb, handover: number): Rgb {
  if (sphere === null) return own;
  const t = Math.min(Math.max(handover, 0), 1);
  return [sphere[0] + (own[0] - sphere[0]) * t, sphere[1] + (own[1] - sphere[1]) * t, sphere[2] + (own[2] - sphere[2]) * t];
}

/** The opacity a label of the style draws at: its own under the frame's factor for its kind (the Swift `LabelOpacityFrame.opacity(of:)`). */
export function labelOpacityOf(style: PreparedLabelTextStyle, frame: LabelOpacityFrame): number {
  return style.opacity * (style.isPointOfInterest ? frame.pois : frame.names);
}

/**
 * The share of the overview's content drawn at a camera zoom (the Swift
 * `ImmersiveMapZoomFade.overview`, a fade in from zoom 0 to 1): the labels
 * of the first zoom level come in as the camera leaves the whole planet.
 */
export function overviewFadeAlpha(zoom: number): number {
  const t = Math.min(Math.max(zoom, 0), 1);
  return t * t * (3 - 2 * t);
}
