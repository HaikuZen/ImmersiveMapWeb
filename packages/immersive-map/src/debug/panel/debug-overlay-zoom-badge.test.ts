// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayZoomBadgeTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { DebugOverlayZoomBadge } from "./debug-overlay-zoom-badge.ts";

describe("DebugOverlayZoomBadge", () => {
  test("the badge reads both zooms to two places", () => {
    expect(DebugOverlayZoomBadge.lines(12.604, 11.5)).toEqual(["z 12.60", "plan 11.50"]);
  });

  /** In the top trailing corner under the safe area, the margin off both edges, and in the leading corner for a right-to-left layout. */
  test("the badge sits in the top trailing corner", () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    const size = { width: 120, height: 60 };
    expect(DebugOverlayZoomBadge.frame(size, bounds, 20, false)).toEqual({ x: 800 - 16 - 120, y: 36, width: 120, height: 60 });
    expect(DebugOverlayZoomBadge.frame(size, bounds, 0, true).x).toBe(16);
  });

  test("the badge's size pads its text", () => {
    expect(DebugOverlayZoomBadge.size({ width: 95.2, height: 52.1 })).toEqual({ width: 120, height: 65 });
  });

  /** Shown with the panel by default, and an omitted value leaves it as configured. */
  test("the debug panel modifier sets the badge", () => {
    expect(ImmersiveMapSettings.default.debugPanel().debug.showsZoomBadge).toBe(true);
    const off = ImmersiveMapSettings.default.debugPanel(true, { zoomBadge: false });
    expect(off.debug.showsZoomBadge).toBe(false);
    expect(off.debugPanel().debug.showsZoomBadge).toBe(false);
  });
});
