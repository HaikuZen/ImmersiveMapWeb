// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `AttributionHiddenNoticeTests`.

import { describe, expect, test, vi } from "vitest";
import { ImmersiveMapAttribution } from "../../configuration/attribution.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { AttributionHiddenNotice } from "./attribution-hidden-notice.ts";

describe("AttributionHiddenNotice", () => {
  /** The notice is page wide: without the reset another test (or another run order) would decide the outcome. */
  test("logs once per page", () => {
    const notice = new AttributionHiddenNotice();
    expect(notice.shouldLog()).toBe(true);
    expect(notice.shouldLog()).toBe(false);
    notice.reset();
    expect(notice.shouldLog()).toBe(true);
  });

  test("the default settings do not warrant a warning", () => {
    expect(AttributionHiddenNotice.isWarningWarranted(ImmersiveMapSettings.default)).toBe(false);
  });

  test("a hidden badge warrants a warning", () => {
    expect(AttributionHiddenNotice.isWarningWarranted(ImmersiveMapSettings.default.attributionSettings({ isVisible: false }))).toBe(true);
  });

  /** An empty override leaves the badge empty, and that is as invisible as hiding it. */
  test("an empty attribution override warrants a warning", () => {
    const settings = ImmersiveMapSettings.default.attributionSettings({ attributionOverride: ImmersiveMapAttribution.none });
    expect(AttributionHiddenNotice.isWarningWarranted(settings)).toBe(true);
  });

  test("the external declaration silences a hidden badge", () => {
    const settings = ImmersiveMapSettings.default.attributionSettings({ isVisible: false }).attributionProvidedExternally();
    expect(AttributionHiddenNotice.isWarningWarranted(settings)).toBe(false);
  });

  /** The declaration alone changes nothing for a visible badge. */
  test("a visible badge with the declaration stays silent", () => {
    expect(AttributionHiddenNotice.isWarningWarranted(ImmersiveMapSettings.default.attributionProvidedExternally())).toBe(false);
  });

  test("the warning goes to the console once, and only when warranted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const notice = new AttributionHiddenNotice();
      AttributionHiddenNotice.warnIfWarranted(ImmersiveMapSettings.default, notice);
      expect(warn).not.toHaveBeenCalled();
      const hidden = ImmersiveMapSettings.default.attributionSettings({ isVisible: false });
      AttributionHiddenNotice.warnIfWarranted(hidden, notice);
      AttributionHiddenNotice.warnIfWarranted(hidden, notice);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(AttributionHiddenNotice.message);
    } finally {
      warn.mockRestore();
    }
  });
});
