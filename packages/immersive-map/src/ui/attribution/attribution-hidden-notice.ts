// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapAttribution } from "../../configuration/attribution.ts";
import type { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";

/**
 * One hidden-attribution warning per page (Swift `AttributionHiddenNotice`):
 * every map built with a hidden badge carries the same news, and the
 * license obligation belongs to the app, not to whichever map happened to
 * appear first.
 */
export class AttributionHiddenNotice {
  static readonly shared = new AttributionHiddenNotice();

  static readonly message =
    "ImmersiveMap: the attribution badge is hidden or empty, but map data licenses " +
    "(ODbL for OpenStreetMap data) require visible attribution near the map. Show the " +
    "data credit in your app, or make the badge visible. If your app already shows the " +
    "credit, declare it with settings.attributionProvidedExternally() to silence this warning. " +
    "What has to be credited and where it has to appear: " +
    "https://github.com/artembobkin/ImmersiveMap#attribution";

  private didLog = false;

  /** True the first time only. */
  shouldLog(): boolean {
    if (this.didLog) return false;
    this.didLog = true;
    return true;
  }

  /** Test hook: the notice is page wide, so a test that did not clear it would be decided by whichever test ran first. */
  reset(): void {
    this.didLog = false;
  }

  /**
   * Pure decision, so tests need no map: the badge is hidden or has nothing
   * to draw, and the app has not declared that it shows the credit itself.
   */
  static isWarningWarranted(settings: ImmersiveMapSettings): boolean {
    return !settings.attribution.isProvidedExternally && (!settings.attribution.isVisible || ImmersiveMapAttribution.isEmpty(settings.resolvedAttribution));
  }

  /** Logs the warning once per page when the settings warrant it. */
  static warnIfWarranted(settings: ImmersiveMapSettings, notice: AttributionHiddenNotice = AttributionHiddenNotice.shared): void {
    if (AttributionHiddenNotice.isWarningWarranted(settings) && notice.shouldLog()) console.warn(AttributionHiddenNotice.message);
  }
}
