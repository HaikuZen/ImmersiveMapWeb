// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { DebugOverlayRect } from "./debug-overlay-geometry.ts";

/**
 * The fixed measures of the panel (the Swift panel view's `Layout`), in CSS
 * pixels: a rail of fixed width, laid out top down, the one group whose
 * height follows the data (the tile list) last, so a tile arriving cannot
 * shove a control the pointer is aimed at.
 */
export const DebugOverlayPanelMetrics = Object.freeze({
  contentInset: 10,
  headerHeight: 30,
  groupHeaderHeight: 24,
  controlRowHeight: 28,
  /** The sun picker's views, each a square of this side at most. */
  sunPickerSide: 200,
  controlSpacing: 6,
  groupSpacing: 16,
  /** A ring rule's card: the rows of one rule on a lighter plate with the rule's name over them. */
  ruleCardInset: 8,
  ruleCardCornerRadius: 8,
  ruleCardSpacing: 8,
  ruleCardTitleHeight: 20,
  ruleCardAlpha: 0.06,
  traceStatusHeight: 24,
  /** A zoom curve's graph and the title over it: tall enough that a value is aimed at in hundredths of its range. */
  graphHeight: 96,
  graphTitleHeight: 18,
  hintRowHeight: 14,
  /** The strip of category tabs under the header. */
  tabBarHeight: 34,
  tabHeight: 24,
  tabPadding: 20,
  /** Nearly opaque: the panel is read while the map moves under it, and a translucent one turns every label behind it into noise across the text. */
  backgroundAlpha: 0.9,
  /** A fixed width, so the map does not move every time a number gains a digit. */
  panelWidth: 600,
  collapsedWidth: 170,
  /** The share of a control row given to its name, the control takes the rest. */
  controlLabelFraction: 0.46,
  /** Kept clear on the right for the vertical scrollbar (`DebugOverlayPanelLayout.scrolledContentWidth`). */
  scrollerGutter: 18,
  /** The hint under the graphs of zoom curves. */
  graphHint: "Click to add a point, drag to move it, double-click to remove it",
});

/** The measures of the debug panel's layout (the Swift `DebugOverlayPanelLayout`), in CSS pixels. */
export const DebugOverlayPanelLayout = {
  /** The body's height: the preferred one, capped to the room the viewport leaves under the panel's top and its chrome, never under the minimum. */
  visibleBodyHeight(
    preferredBodyHeight: number,
    viewportHeight: number,
    panelMinY: number,
    chromeHeight: number,
    minimumBodyHeight: number,
  ): number {
    const availableHeight = viewportHeight - panelMinY - chromeHeight;
    const maximumBodyHeight = Math.max(minimumBodyHeight, availableHeight);
    return Math.min(preferredBodyHeight, maximumBodyHeight);
  },

  /**
   * The width available to a row inside the scrolled column, measured from
   * the scrolling element's content width rather than the panel's: a
   * classic scrollbar takes its width out of the content while an overlay
   * one floats above it, and which of the two the browser draws is the
   * system's choice, not the panel's. `scrollerGutter` is kept clear on the
   * right so a right-aligned control lands under neither. One pixel at
   * least.
   */
  scrolledContentWidth(scrollWidth: number, leadingInset: number, scrollerGutter: number): number {
    return Math.max(1, scrollWidth - leadingInset - scrollerGutter);
  },

  /** The right edge of a row laid out at `leadingInset` with that width, the value a right-aligned control ends at. */
  rowTrailingEdge(scrollWidth: number, leadingInset: number, scrollerGutter: number): number {
    return leadingInset + DebugOverlayPanelLayout.scrolledContentWidth(scrollWidth, leadingInset, scrollerGutter);
  },

  /**
   * The height of a list that always reserves `slotCount` rows, whatever it
   * holds. A list whose height follows its contents moves everything laid
   * out after it, and in the panel that meant tiles arriving mid-zoom shoved
   * the controls under the pointer.
   */
  fixedListHeight(slotCount: number, slotHeight: number, spacing: number): number {
    if (slotCount <= 0) return 0;
    return slotCount * slotHeight + (slotCount - 1) * spacing;
  },

  /**
   * How many rows of the given heights fit in `availableHeight`, laid out
   * top down with `spacing` between them. The rows are not all of one
   * height, so the count is walked rather than divided. The first row pays
   * no spacing.
   */
  visibleRowCount(rowHeights: readonly number[], spacing: number, availableHeight: number): number {
    let used = 0;
    let count = 0;
    for (const height of rowHeights) {
      const next = count === 0 ? height : used + spacing + height;
      if (next > availableHeight) break;
      used = next;
      count += 1;
    }
    return count;
  },

  /**
   * The columns of a card grid: as many cards of `minimumCardWidth` as fit
   * in `width` with `spacing` between them, one at least. The cards then
   * stretch to share the width.
   */
  cardColumnCount(width: number, minimumCardWidth: number, spacing: number): number {
    return Math.max(1, Math.floor((width + spacing) / (minimumCardWidth + spacing)));
  },

  /** The frame of the card at `index` in a grid of `columns`, filled row by row from the top left. */
  cardFrame(index: number, columns: number, width: number, cardHeight: number, spacing: number): DebugOverlayRect {
    const count = Math.max(1, columns);
    const cardWidth = (width - (count - 1) * spacing) / count;
    const column = index % count;
    const row = Math.floor(index / count);
    return { x: column * (cardWidth + spacing), y: row * (cardHeight + spacing), width: cardWidth, height: cardHeight };
  },

  /** The height of a grid holding `cardCount` cards in `columns`. */
  cardGridHeight(cardCount: number, columns: number, cardHeight: number, spacing: number): number {
    const count = Math.max(1, columns);
    return DebugOverlayPanelLayout.fixedListHeight(Math.floor((cardCount + count - 1) / count), cardHeight, spacing);
  },

  /** A row's rectangle: the whole width of the list's bounds at the row's top, whatever part of it is being redrawn. */
  rowDrawRect(bounds: DebugOverlayRect, rowTop: number, rowHeight: number): DebugOverlayRect {
    return { x: bounds.x, y: rowTop, width: bounds.width, height: rowHeight };
  },
} as const;
