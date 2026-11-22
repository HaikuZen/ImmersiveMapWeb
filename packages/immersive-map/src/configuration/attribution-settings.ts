// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapAttribution } from "./attribution.ts";
import type { Rgba } from "./color.ts";
import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";

/**
 * Badge size preset. Scales fonts, paddings and the maximum badge width
 * coherently. The concrete metrics live in the badge's own code.
 */
export type AttributionSize = "small" | "regular" | "large";

export const attributionSizes: readonly AttributionSize[] = Object.freeze(["small", "regular", "large"]);

/**
 * Where the badge sits inside the map view, inset by the safe area (the
 * bottom one only with `respectsBottomSafeArea`). Leading and trailing
 * follow the page's writing direction.
 */
export type AttributionPosition = "bottomTrailing" | "bottomLeading" | "topTrailing" | "topLeading" | "bottomCenter" | "topCenter";

export const attributionPositions: readonly AttributionPosition[] = Object.freeze([
  "bottomTrailing",
  "bottomLeading",
  "topTrailing",
  "topLeading",
  "bottomCenter",
  "topCenter",
]);

/**
 * Attribution badge settings. The default text comes from the tile source:
 * we credit whoever's data we display. Overriding it makes sense only when
 * the app shows the source attribution elsewhere (its own "About" screen, a
 * custom overlay) and the source's license permits that.
 */
export interface AttributionSettings {
  /** Whether the badge is drawn. On by default. */
  readonly isVisible: boolean;
  readonly size: AttributionSize;
  readonly position: AttributionPosition;
  /**
   * Distance in points between the badge and the view edges (applied after
   * the safe area). 0, the default, pins the badge tightly into its corner.
   * Raise it to float the badge over the map.
   */
  readonly margin: number;
  /**
   * Whether a badge at the bottom stays above the view's bottom safe area
   * (`env(safe-area-inset-bottom)`, a phone's home indicator). Off, the
   * default, it sits at the map view's bottom edge, moved in from the sides
   * by the bottom safe area's height so the screen's rounded corners do not
   * cut the line. A map with no bottom inset has the badge where it always
   * did. Turn it on to keep the line clear of the home indicator. The top
   * and side safe areas are always kept.
   */
  readonly respectsBottomSafeArea: boolean;
  /**
   * Badge text color as RGBA in `0...1` (same convention as
   * `PinSettings.borderColor`). Null keeps the default white. The line
   * renders at the given alpha, so a translucent badge is a colour with an
   * alpha under 1.
   */
  readonly textColor: Rgba | null;
  /**
   * Whether the first credit on the line leads: bold at the colour's alpha,
   * the rest of the line at 76% of it. The first is the engine's own while
   * `showsEngineCredit` holds, and the tile source's otherwise. Off, the
   * default, every credit is set the same way, as one list.
   */
  readonly emphasizesLeadingCredit: boolean;
  /**
   * The app declares that it shows the data credit itself (its own overlay,
   * an about screen). Suppresses the hidden-attribution warning. It does not
   * change what the badge draws.
   */
  readonly isProvidedExternally: boolean;
  /**
   * Whether the engine's own credit, "Powered by ImmersiveMap", opens the
   * badge's line (`ImmersiveMapAttribution.engineCredit`). On by default. A
   * courtesy, not a license term: off leaves the data's credits alone.
   */
  readonly showsEngineCredit: boolean;
  /**
   * The credit the badge shows in place of the tile source's, null for the
   * hosted service's. An empty one is the app taking the whole credit off
   * the badge (`ImmersiveMapSettings.resolvedAttribution`).
   */
  readonly attributionOverride: ImmersiveMapAttribution | null;
}

export const defaultAttributionSettings: AttributionSettings = Object.freeze({
  isVisible: true,
  size: "regular",
  position: "bottomTrailing",
  margin: 0,
  respectsBottomSafeArea: false,
  textColor: null,
  emphasizesLeadingCredit: false,
  isProvidedExternally: false,
  showsEngineCredit: true,
  attributionOverride: null,
});

export function attributionSettings(options: Options<AttributionSettings> = {}): AttributionSettings {
  return deepFreeze(mergeOptions(defaultAttributionSettings, options));
}
