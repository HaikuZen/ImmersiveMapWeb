// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapAttribution, type ImmersiveMapAttributionCredit } from "../../configuration/attribution.ts";
import type { AttributionSettings } from "../../configuration/attribution-settings.ts";
import type { Rgba } from "../../configuration/color.ts";
import { AttributionBadgeLayoutMath } from "./attribution-badge-layout-math.ts";

/** One run of the badge's line: a credit or the dot between two, in one face and one alpha. */
export interface AttributionLineSegment {
  readonly text: string;
  /** The CSS font weight: 600 (semibold) for the line, 700 for a leading credit. */
  readonly fontWeight: 600 | 700;
  /** The share of the colour's alpha the run is drawn at. */
  readonly alphaShare: number;
}

/**
 * The badge's line as data (Swift `AttributionBadgeView.lineText`): every
 * credit and the dots between them in the semibold face at the colour's own
 * alpha, one list. With `emphasizesLeading` the first credit is bold and the
 * rest of the line a shade dimmer (`dimmedCreditAlpha`), so the first credit
 * leads the rest.
 */
export const AttributionBadgeLine = Object.freeze({
  /**
   * The halo around every glyph: a dark shadow on the glyph itself, blurred
   * by this many pixels, so its edge fades into the map rather than ending
   * in a hard line.
   */
  haloBlurRadius: 3.5,
  haloAlpha: 0.95,
  /** The share of the colour's alpha the credits behind a leading one are drawn at. */
  dimmedCreditAlpha: 0.76,
  /** The text colour when the settings give none. */
  defaultTextColor: Object.freeze([1, 1, 1, 1]) as Rgba,

  segments(credits: readonly ImmersiveMapAttributionCredit[], emphasizesLeading: boolean): AttributionLineSegment[] {
    const segments: AttributionLineSegment[] = [];
    const restAlpha = emphasizesLeading ? AttributionBadgeLine.dimmedCreditAlpha : 1;
    credits.forEach((credit, index) => {
      if (index > 0) {
        segments.push({ text: AttributionBadgeLayoutMath.creditSeparator, fontWeight: 600, alphaShare: restAlpha });
      }
      const leads = emphasizesLeading && index === 0;
      segments.push({ text: credit.text, fontWeight: leads ? 700 : 600, alphaShare: leads ? 1 : restAlpha });
    });
    return segments;
  },

  /** The words of the line. */
  text(segments: readonly AttributionLineSegment[]): string {
    return segments.map((segment) => segment.text).join("");
  },

  /** The CSS colour of a run: the settings' colour at its alpha times the run's share. */
  cssColor(color: Rgba, alphaShare: number): string {
    const channel = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * 255);
    return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${round(color[3] * alphaShare)})`;
  },

  /** The CSS text shadow of a run: the dark halo, faded with the run. */
  cssHalo(alphaShare: number): string {
    return `0 0 ${AttributionBadgeLine.haloBlurRadius}px rgba(0, 0, 0, ${round(AttributionBadgeLine.haloAlpha * alphaShare)})`;
  },
});

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * What the badge shows, without the DOM: the attribution and the look, and
 * the camera's zoom. The line changes only when a credit's zoom range is
 * crossed, which `applyZoom` reports, so the badge writes to the DOM then
 * and on no other frame.
 */
export class AttributionBadgeState {
  private attributionValue: ImmersiveMapAttribution = ImmersiveMapAttribution.none;
  private settingsValue: AttributionSettings | null = null;
  private zoom: number | null = null;
  private shown: ImmersiveMapAttributionCredit[] = [];

  get attribution(): ImmersiveMapAttribution {
    return this.attributionValue;
  }

  /** The credits on the line, in order. */
  get shownCredits(): readonly ImmersiveMapAttributionCredit[] {
    return this.shown;
  }

  /** The badge shows: it is visible and has words at the zoom. */
  get isShown(): boolean {
    return (this.settingsValue?.isVisible ?? true) && this.shown.length > 0;
  }

  /** The badge takes taps: it shows and has somewhere to lead. */
  get isInteractive(): boolean {
    return this.isShown && this.attributionValue.linkURL !== null;
  }

  /** The credits and the look. Always changes the line. */
  apply(attribution: ImmersiveMapAttribution, settings: AttributionSettings): void {
    this.attributionValue = attribution;
    this.settingsValue = settings;
    this.shown = ImmersiveMapAttribution.creditsAtZoom(attribution, this.zoom);
  }

  /**
   * The camera's zoom, on every frame. Returns whether the line changed. A
   * zoom inside the same ranges allocates nothing.
   */
  applyZoom(zoom: number | null): boolean {
    this.zoom = zoom;
    if (showsTheSameCredits(this.attributionValue, zoom, this.shown)) {
      return false;
    }
    this.shown = ImmersiveMapAttribution.creditsAtZoom(this.attributionValue, zoom);
    return true;
  }

  segments(): AttributionLineSegment[] {
    return AttributionBadgeLine.segments(this.shown, this.settingsValue?.emphasizesLeadingCredit ?? false);
  }
}

/** Whether the credits shown at `zoom` are `shown`, compared in place. */
function showsTheSameCredits(attribution: ImmersiveMapAttribution, zoom: number | null, shown: readonly ImmersiveMapAttributionCredit[]): boolean {
  let index = 0;
  for (const credit of attribution.credits) {
    if (credit.text.length === 0 || !ImmersiveMapAttribution.isShown(credit, zoom)) continue;
    if (shown[index] !== credit) return false;
    index += 1;
  }
  return index === shown.length;
}
