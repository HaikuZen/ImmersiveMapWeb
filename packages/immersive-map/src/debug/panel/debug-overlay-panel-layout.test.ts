// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayPanelLayoutTests`.

import { describe, expect, test } from "vitest";
import { DebugOverlayPanelLayout } from "./debug-overlay-panel-layout.ts";

describe("DebugOverlayPanelLayout", () => {
  test("the body's height is capped to the room the panel has", () => {
    expect(DebugOverlayPanelLayout.visibleBodyHeight(1400, 844, 20, 220, 48)).toBe(604);
  });

  test("the body keeps its preferred height when it fits", () => {
    expect(DebugOverlayPanelLayout.visibleBodyHeight(320, 844, 20, 220, 48)).toBe(320);
  });

  test("a row's rectangle spans the bounds' width", () => {
    expect(DebugOverlayPanelLayout.rowDrawRect({ x: 0, y: 0, width: 360, height: 120 }, 32, 28)).toEqual({ x: 0, y: 32, width: 360, height: 28 });
  });

  /** The list reserves the same height whatever it holds, which is what stops a tile arriving mid-zoom from moving everything under it. */
  test("a fixed list's height is the slot ladder", () => {
    expect(DebugOverlayPanelLayout.fixedListHeight(12, 28, 4)).toBe(12 * 28 + 11 * 4);
    expect(DebugOverlayPanelLayout.fixedListHeight(1, 28, 4)).toBe(28);
    expect(DebugOverlayPanelLayout.fixedListHeight(0, 28, 4)).toBe(0);
  });

  test("rows of a slot's height fill their slots exactly", () => {
    const height = DebugOverlayPanelLayout.fixedListHeight(12, 28, 4);
    expect(DebugOverlayPanelLayout.visibleRowCount(Array<number>(20).fill(28), 4, height)).toBe(12);
  });

  /** Shorter rows fit more of themselves: the reserved height is what is fixed, not the row count. */
  test("shorter rows fit more of themselves", () => {
    const height = DebugOverlayPanelLayout.fixedListHeight(12, 28, 4);
    const count = DebugOverlayPanelLayout.visibleRowCount(Array<number>(40).fill(22), 4, height);
    expect(count).toBeGreaterThan(12);
    expect(count * 22 + (count - 1) * 4).toBeLessThanOrEqual(height);
    expect((count + 1) * 22 + count * 4).toBeGreaterThan(height);
  });

  test("fewer rows than slots are all visible", () => {
    const height = DebugOverlayPanelLayout.fixedListHeight(12, 28, 4);
    expect(DebugOverlayPanelLayout.visibleRowCount([28, 28, 22], 4, height)).toBe(3);
  });

  test("no row fits in no space", () => {
    expect(DebugOverlayPanelLayout.visibleRowCount([28, 28], 4, 0)).toBe(0);
    expect(DebugOverlayPanelLayout.visibleRowCount([], 4, 400)).toBe(0);
  });

  /** The first row pays no spacing, so a list exactly one row tall shows it. */
  test("a single row needs no spacing", () => {
    expect(DebugOverlayPanelLayout.visibleRowCount([28, 28], 4, 28)).toBe(1);
    expect(DebugOverlayPanelLayout.visibleRowCount([28, 28], 4, 31)).toBe(1);
  });

  /** With a classic scrollbar every right-aligned switch must still end left of it. */
  test("a right-aligned control clears the scrollbar", () => {
    const panelWidth = 600;
    const inset = 10;
    const gutter = 18;
    for (const scrollerWidth of [0, 15, 16]) {
      const scrollWidth = panelWidth - scrollerWidth;
      const trailing = DebugOverlayPanelLayout.rowTrailingEdge(scrollWidth, inset, gutter);
      expect(trailing).toBeLessThanOrEqual(scrollWidth - gutter + 0.001);
      expect(trailing).toBeLessThanOrEqual(panelWidth);
    }
  });

  test("the content width never goes under a pixel", () => {
    expect(DebugOverlayPanelLayout.scrolledContentWidth(4, 10, 18)).toBe(1);
  });

  test("the content width is the space between the inset and the gutter", () => {
    expect(DebugOverlayPanelLayout.scrolledContentWidth(600, 10, 18)).toBe(572);
  });

  test("the card grid fills the width in as many columns as fit", () => {
    expect(DebugOverlayPanelLayout.cardColumnCount(560, 250, 6)).toBe(2);
    expect(DebugOverlayPanelLayout.cardColumnCount(360, 250, 6)).toBe(1);
    expect(DebugOverlayPanelLayout.cardColumnCount(100, 250, 6)).toBe(1);
    expect(DebugOverlayPanelLayout.cardColumnCount(762, 250, 6)).toBe(3);

    expect(DebugOverlayPanelLayout.cardFrame(1, 2, 506, 72, 6)).toEqual({ x: 256, y: 0, width: 250, height: 72 });
    expect(DebugOverlayPanelLayout.cardFrame(2, 2, 506, 72, 6)).toEqual({ x: 0, y: 78, width: 250, height: 72 });

    expect(DebugOverlayPanelLayout.cardGridHeight(3, 2, 72, 6)).toBe(150);
    expect(DebugOverlayPanelLayout.cardGridHeight(0, 2, 72, 6)).toBe(0);
  });
});
