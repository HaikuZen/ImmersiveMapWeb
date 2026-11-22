// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { AttributionPosition, AttributionSize } from "../../configuration/attribution-settings.ts";

/** Edge insets in CSS pixels. */
export interface BadgeEdgeInsets {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

export interface BadgeSize {
  readonly width: number;
  readonly height: number;
}

/** A rectangle in CSS pixels, top-left origin. */
export interface BadgeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Concrete metrics of one badge size preset. */
export interface AttributionBadgeMetrics {
  /** The text's size. Every credit on the line shares it. */
  readonly fontSize: number;
  readonly horizontalInset: number;
  readonly verticalInset: number;
}

/**
 * The badge's place as CSS: the edge offsets of an absolutely positioned
 * element in the map's container, its translation and its widest extent.
 * The values are CSS expressions over `env(safe-area-inset-*)`, so the
 * browser applies the safe area itself and nothing is measured.
 */
export interface AttributionBadgeCssPlacement {
  readonly top: string;
  readonly bottom: string;
  readonly left: string;
  readonly right: string;
  readonly transform: string;
  readonly maxWidth: string;
}

const smallMetrics: AttributionBadgeMetrics = Object.freeze({ fontSize: 10, horizontalInset: 8, verticalInset: 5 });
const regularMetrics: AttributionBadgeMetrics = Object.freeze({ fontSize: 12, horizontalInset: 10, verticalInset: 7 });
const largeMetrics: AttributionBadgeMetrics = Object.freeze({ fontSize: 14, horizontalInset: 12, verticalInset: 9 });

function isBottom(position: AttributionPosition): boolean {
  return position === "bottomLeading" || position === "bottomTrailing" || position === "bottomCenter";
}

type HorizontalAnchor = "leading" | "trailing" | "center";

function horizontalAnchor(position: AttributionPosition): HorizontalAnchor {
  switch (position) {
    case "bottomTrailing":
    case "topTrailing":
      return "trailing";
    case "bottomLeading":
    case "topLeading":
      return "leading";
    case "bottomCenter":
    case "topCenter":
      return "center";
  }
}

/** A CSS length in pixels. */
function px(value: number): string {
  return `${value}px`;
}

/**
 * Stateless layout math of the attribution badge (Swift
 * `AttributionBadgeLayoutMath`). All coordinates have a top-left origin, in
 * CSS pixels. The DOM badge places itself with `cssPlacement`, the same
 * rules stated as CSS, and the frame functions keep the rules testable as
 * numbers.
 */
export const AttributionBadgeLayoutMath = Object.freeze({
  /** The words between two credits on the line. */
  creditSeparator: " · ",

  metrics(size: AttributionSize): AttributionBadgeMetrics {
    switch (size) {
      case "small":
        return smallMetrics;
      case "regular":
        return regularMetrics;
      case "large":
        return largeMetrics;
    }
  },

  /**
   * The insets the badge keeps from the view's edges, from the view's safe
   * area. A badge at the bottom that does not respect the bottom safe area
   * (`AttributionSettings.respectsBottomSafeArea`) sits at the bottom edge,
   * and moves in from each side by at least the bottom inset: a screen with
   * a home indicator has rounded corners, and that much keeps them from
   * cutting the line. A view with no bottom inset keeps its insets as they
   * are.
   */
  badgeInsets(safeAreaInsets: BadgeEdgeInsets, position: AttributionPosition, respectsBottomSafeArea: boolean): BadgeEdgeInsets {
    if (!isBottom(position) || respectsBottomSafeArea || !(safeAreaInsets.bottom > 0)) {
      return safeAreaInsets;
    }
    return {
      top: safeAreaInsets.top,
      left: Math.max(safeAreaInsets.left, safeAreaInsets.bottom),
      right: Math.max(safeAreaInsets.right, safeAreaInsets.bottom),
      bottom: 0,
    };
  },

  /**
   * Width the badge may occupy: bounds minus safe area minus the margin on
   * both sides. The margin is the app-configured distance between the badge
   * and the view edges. 0, the default, pins the badge into its corner.
   */
  availableWidth(bounds: BadgeRect, safeAreaInsets: BadgeEdgeInsets, margin: number): number {
    return Math.max(0, bounds.width - safeAreaInsets.left - safeAreaInsets.right - margin * 2);
  },

  /**
   * Badge size from the measured size of the line: the line and its insets,
   * no wider than the width it is given, where the line is cut.
   */
  badgeSize(textSize: BadgeSize, metrics: AttributionBadgeMetrics, boundingWidth: number): BadgeSize {
    return {
      width: Math.min(boundingWidth, Math.ceil(textSize.width + metrics.horizontalInset * 2)),
      height: Math.ceil(textSize.height + metrics.verticalInset * 2),
    };
  },

  /**
   * Badge frame for a position, safe-area aware. Leading and trailing flip
   * with the layout direction, centres do not.
   */
  badgeFrame(
    badgeSize: BadgeSize,
    position: AttributionPosition,
    bounds: BadgeRect,
    safeAreaInsets: BadgeEdgeInsets,
    margin: number,
    isRightToLeft: boolean,
  ): BadgeRect {
    const minX = safeAreaInsets.left + margin;
    const minY = safeAreaInsets.top + margin;
    const width = Math.max(0, bounds.width - safeAreaInsets.left - safeAreaInsets.right - margin * 2);
    const height = Math.max(0, bounds.height - safeAreaInsets.top - safeAreaInsets.bottom - margin * 2);
    const maxX = minX + width;
    const maxY = minY + height;

    let x: number;
    switch (horizontalAnchor(position)) {
      case "leading":
        x = isRightToLeft ? maxX - badgeSize.width : minX;
        break;
      case "trailing":
        x = isRightToLeft ? minX : maxX - badgeSize.width;
        break;
      case "center":
        x = minX + width / 2 - badgeSize.width / 2;
        break;
    }
    const y = isBottom(position) ? maxY - badgeSize.height : minY;
    return { x, y, width: badgeSize.width, height: badgeSize.height };
  },

  /** The line's frame inside the badge: the badge less its insets. */
  labelFrame(badgeBounds: BadgeRect, metrics: AttributionBadgeMetrics): BadgeRect {
    return {
      x: badgeBounds.x + metrics.horizontalInset,
      y: badgeBounds.y + metrics.verticalInset,
      width: badgeBounds.width - metrics.horizontalInset * 2,
      height: badgeBounds.height - metrics.verticalInset * 2,
    };
  },

  /**
   * `badgeFrame` and `badgeInsets` as CSS: the safe area is the page's
   * `env(safe-area-inset-*)`, read by the browser. A bottom badge that does
   * not respect the bottom safe area sits on the bottom edge and moves in
   * from the sides by at least the bottom inset, as `badgeInsets` says, and
   * its width is capped by `availableWidth` over the same insets. Leading
   * and trailing flip with the writing direction, centres do not.
   */
  cssPlacement(position: AttributionPosition, margin: number, respectsBottomSafeArea: boolean, isRightToLeft: boolean): AttributionBadgeCssPlacement {
    const top = "env(safe-area-inset-top, 0px)";
    const bottom = "env(safe-area-inset-bottom, 0px)";
    const bottomEdge = isBottom(position);
    const movesInFromTheSides = bottomEdge && !respectsBottomSafeArea;
    // The bottom inset is zero on a screen without one, so the max keeps the side inset there.
    const left = movesInFromTheSides ? `max(env(safe-area-inset-left, 0px), ${bottom})` : "env(safe-area-inset-left, 0px)";
    const right = movesInFromTheSides ? `max(env(safe-area-inset-right, 0px), ${bottom})` : "env(safe-area-inset-right, 0px)";
    const marginPx = px(margin);
    const vertical = bottomEdge ? (respectsBottomSafeArea ? `calc(${bottom} + ${marginPx})` : marginPx) : `calc(${top} + ${marginPx})`;
    const anchor = horizontalAnchor(position);
    const onTheLeft = (anchor === "leading") !== isRightToLeft;
    const centered = anchor === "center";
    return {
      top: bottomEdge ? "auto" : vertical,
      bottom: bottomEdge ? vertical : "auto",
      left: centered ? `calc(50% + (${left} - ${right}) / 2)` : onTheLeft ? `calc(${left} + ${marginPx})` : "auto",
      right: centered || onTheLeft ? "auto" : `calc(${right} + ${marginPx})`,
      transform: centered ? "translateX(-50%)" : "none",
      maxWidth: `max(0px, calc(100% - ${left} - ${right} - ${px(margin * 2)}))`,
    };
  },
});
