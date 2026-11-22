// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `AttributionBadgeViewTests` and `AttributionBadgeViewMacTests`:
// the line's words, faces and alphas, and when it changes with the zoom.
// The badge's measured sizes are left to the browser (no layout tests).

import { describe, expect, test } from "vitest";
import { ImmersiveMapAttribution } from "../../configuration/attribution.ts";
import { attributionSettings } from "../../configuration/attribution-settings.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { AttributionBadgeLayoutMath } from "./attribution-badge-layout-math.ts";
import { AttributionBadgeLine, AttributionBadgeState } from "./attribution-badge-line.ts";

function stateFor(settings: ImmersiveMapSettings): AttributionBadgeState {
  const state = new AttributionBadgeState();
  state.apply(settings.resolvedAttribution, settings.attribution);
  return state;
}

const lineOf = (state: AttributionBadgeState) => AttributionBadgeLine.text(state.segments());
// The relief on, so the terrain's credit is on the line too.
const withRelief = ImmersiveMapSettings.default.groundRelief({ isEnabled: true });

describe("the attribution badge's line", () => {
  test("the default badge shows and takes taps", () => {
    const state = stateFor(ImmersiveMapSettings.default);
    expect(state.isShown).toBe(true);
    expect(state.isInteractive).toBe(true);
  });

  /** One line, every credit on it before the camera is placed, the terrain's included, in a dark halo. */
  test("the badge is one line of credits in a halo", () => {
    const state = stateFor(withRelief);
    expect(lineOf(state)).toBe("Powered by ImmersiveMap · © OpenStreetMap · Biomes © RESOLVE, CC BY 4.0 · © Mapterhorn");
    expect(AttributionBadgeLine.cssHalo(1)).toBe(`0 0 ${AttributionBadgeLine.haloBlurRadius}px rgba(0, 0, 0, 0.95)`);
  });

  /**
   * The overview's credit is on the line at the zooms the overview is drawn
   * at and off it past them, where the terrain's takes its place at the
   * zooms the relief rises at.
   */
  test("a credit leaves the line with the zoom", () => {
    const state = stateFor(withRelief);
    expect(state.applyZoom(3)).toBe(true);
    expect(lineOf(state)).toBe("Powered by ImmersiveMap · © OpenStreetMap · Biomes © RESOLVE, CC BY 4.0");
    expect(state.applyZoom(12.2)).toBe(true);
    expect(lineOf(state)).toBe("Powered by ImmersiveMap · © OpenStreetMap · © Mapterhorn");
    expect(state.applyZoom(7.9)).toBe(true);
    expect(lineOf(state)).toBe("Powered by ImmersiveMap · © OpenStreetMap · Biomes © RESOLVE, CC BY 4.0");
  });

  /** A zoom inside the same ranges changes nothing, so the badge writes nothing on that frame. */
  test("a zoom that keeps the credits does not change the line", () => {
    const state = stateFor(withRelief);
    expect(state.applyZoom(3)).toBe(true);
    const shown = state.shownCredits;
    expect(state.applyZoom(3.5)).toBe(false);
    expect(state.applyZoom(5)).toBe(false);
    expect(state.shownCredits).toBe(shown);
  });

  test("an empty attribution hides the badge", () => {
    const state = new AttributionBadgeState();
    state.apply(ImmersiveMapAttribution.none, attributionSettings());
    expect(state.isShown).toBe(false);
    expect(state.isInteractive).toBe(false);
  });

  /** A line whose every credit has left at a zoom hides the badge, and a credit coming back shows it again. */
  test("the badge hides when no credit shows at the zoom", () => {
    const state = new AttributionBadgeState();
    state.apply(ImmersiveMapAttribution.make([ImmersiveMapAttribution.credit("© Low", { lowerBound: 0, upperBound: 5 })]), attributionSettings());
    state.applyZoom(9);
    expect(state.isShown).toBe(false);
    state.applyZoom(2);
    expect(state.isShown).toBe(true);
  });

  test("a hidden badge shows nothing and takes no taps", () => {
    const state = stateFor(ImmersiveMapSettings.default.attributionSettings({ isVisible: false }));
    expect(state.isShown).toBe(false);
    expect(state.isInteractive).toBe(false);
  });

  test("an attribution without a link takes no taps", () => {
    const state = new AttributionBadgeState();
    state.apply(ImmersiveMapAttribution.single("© Data"), attributionSettings());
    expect(state.isShown).toBe(true);
    expect(state.isInteractive).toBe(false);
  });

  /** Two credits make a longer line with a dot between them. */
  test("a second credit widens the line", () => {
    const segments = AttributionBadgeLine.segments([ImmersiveMapAttribution.credit("© Data"), ImmersiveMapAttribution.credit("© More data")], false);
    expect(AttributionBadgeLine.text(segments)).toBe(`© Data${AttributionBadgeLayoutMath.creditSeparator}© More data`);
  });

  /**
   * By default every credit is set the same way, one list. With
   * `emphasizesLeadingCredit` the first is bold at full strength and the
   * rest a shade dimmer.
   */
  test("the credits are one list unless the first is asked to lead", () => {
    const credits = ImmersiveMapAttribution.creditsAtZoom(ImmersiveMapSettings.default.resolvedAttribution, null);
    expect(credits.length).toBeGreaterThanOrEqual(2);
    const list = AttributionBadgeLine.segments(credits, false);
    // Credit, separator, credit.
    expect(list[0]!.alphaShare).toBe(list[2]!.alphaShare);
    expect(list[0]!.fontWeight).toBe(list[2]!.fontWeight);
    expect(list[0]!.alphaShare).toBe(1);
    expect(AttributionBadgeLine.cssColor([1, 1, 1, 0.5], list[0]!.alphaShare)).toBe("rgba(255, 255, 255, 0.5)");

    const led = AttributionBadgeLine.segments(credits, true);
    expect(led[0]!.alphaShare).toBe(1);
    expect(led[2]!.alphaShare).toBeCloseTo(AttributionBadgeLine.dimmedCreditAlpha, 6);
    expect(led[1]!.alphaShare).toBeCloseTo(AttributionBadgeLine.dimmedCreditAlpha, 6);
    expect(led[0]!.fontWeight).not.toBe(led[2]!.fontWeight);

    const state = stateFor(ImmersiveMapSettings.default.attributionSettings({ emphasizesLeadingCredit: true }));
    expect(state.segments()[0]!.fontWeight).toBe(700);
  });
});
