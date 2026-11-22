// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayControlStateTests`: the panel's toggles
// reach the snapshot, and which of them open the overlay pass.

import { describe, expect, test } from "vitest";
import { defaultDebugSettings } from "../../configuration/view-settings.ts";
import { DebugOverlayControlState, RenderDebugOverlayPolicy } from "./debug-overlay-control-state.ts";
import { DebugTileGridDensity } from "./debug-tile-grid-density.ts";

const panelOn = { ...defaultDebugSettings, enableDebugPanel: true };

describe("DebugOverlayControlState", () => {
  test("the road label tiles toggle reaches the snapshot", () => {
    const controls = new DebugOverlayControlState();
    controls.setRoadLabelTilesEnabled(true);
    expect(controls.snapshot().roadLabelTilesEnabled).toBe(true);
  });

  test("the road label tiles overlay opens the overlay pass", () => {
    const controls = new DebugOverlayControlState();
    controls.setRoadLabelTilesEnabled(true);
    expect(RenderDebugOverlayPolicy.shouldEncode(panelOn, controls.snapshot())).toBe(true);
  });

  test("the two label bounds toggles are independent", () => {
    const controls = new DebugOverlayControlState();
    controls.setBaseLabelBoundsEnabled(true);
    expect(controls.snapshot().baseLabelBoundsEnabled).toBe(true);
    expect(controls.snapshot().roadLabelBoundsEnabled).toBe(false);

    controls.setBaseLabelBoundsEnabled(false);
    controls.setRoadLabelBoundsEnabled(true);
    expect(controls.snapshot().baseLabelBoundsEnabled).toBe(false);
    expect(controls.snapshot().roadLabelBoundsEnabled).toBe(true);
  });

  test("either label bounds toggle opens the overlay pass", () => {
    const base = new DebugOverlayControlState();
    base.setBaseLabelBoundsEnabled(true);
    expect(RenderDebugOverlayPolicy.shouldEncode(panelOn, base.snapshot())).toBe(true);

    const road = new DebugOverlayControlState();
    road.setRoadLabelBoundsEnabled(true);
    expect(RenderDebugOverlayPolicy.shouldEncode(panelOn, road.snapshot())).toBe(true);
  });

  test("the tile grid starts off at the standard density", () => {
    const snapshot = new DebugOverlayControlState().snapshot();
    expect(snapshot.tileGridEnabled).toBe(false);
    expect(snapshot.tileGridDensity).toBe(DebugTileGridDensity.standard);
  });

  test("the tile grid toggle is independent of the tile layers", () => {
    const controls = new DebugOverlayControlState();
    controls.setTileGridEnabled(true);
    expect(controls.snapshot().tileGridEnabled).toBe(true);
    expect(controls.snapshot().tileLayersEnabled).toBe(false);
  });

  test("the tile grid opens the overlay pass", () => {
    const controls = new DebugOverlayControlState();
    controls.setTileGridEnabled(true);
    expect(RenderDebugOverlayPolicy.shouldEncode(panelOn, controls.snapshot())).toBe(true);
  });

  test("the tile grid density is clamped to an offered value", () => {
    const controls = new DebugOverlayControlState();
    controls.setTileGridDensity(8);
    expect(controls.snapshot().tileGridDensity).toBe(8);
    controls.setTileGridDensity(1000);
    expect(controls.snapshot().tileGridDensity).toBe(8);
    controls.setTileGridDensity(0);
    expect(controls.snapshot().tileGridDensity).toBe(2);
  });

  test("the overlay pass stays closed with the panel off or nothing switched on", () => {
    const controls = new DebugOverlayControlState();
    expect(RenderDebugOverlayPolicy.shouldEncode(panelOn, controls.snapshot())).toBe(false);
    controls.setAxesEnabled(true);
    expect(RenderDebugOverlayPolicy.shouldEncode(defaultDebugSettings, controls.snapshot())).toBe(false);
  });

  test("a snapshot is reused until a setter changes it", () => {
    const controls = new DebugOverlayControlState();
    const first = controls.snapshot();
    expect(controls.snapshot()).toBe(first);
    controls.setWireframeEnabled(true);
    expect(controls.snapshot()).not.toBe(first);
    expect(controls.snapshot().wireframeEnabled).toBe(true);
  });

  test("the dragged distances are held to their ranges", () => {
    const controls = new DebugOverlayControlState();
    controls.setLabelPerspectiveMinimumScale(3);
    controls.setLocalLabelMaximumDistanceMeters(-5);
    expect(controls.labelPerspectiveMinimum()).toBe(1);
    expect(controls.localLabelMaximumDistance()).toBe(0);
    controls.setLabelPerspectiveMinimumScale(undefined);
    expect(controls.snapshot().labelPerspectiveMinimumScale).toBeUndefined();
  });
});
