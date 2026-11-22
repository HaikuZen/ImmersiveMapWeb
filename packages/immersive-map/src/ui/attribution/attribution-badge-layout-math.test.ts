// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `AttributionBadgeLayoutMathTests` and `AttributionBadgeMarginTests`,
// with the CSS form of the placement added.

import { describe, expect, test } from "vitest";
import type { AttributionPosition } from "../../configuration/attribution-settings.ts";
import { attributionSettings, defaultAttributionSettings } from "../../configuration/attribution-settings.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { AttributionBadgeLayoutMath, type BadgeEdgeInsets } from "./attribution-badge-layout-math.ts";

const bounds = { x: 0, y: 0, width: 800, height: 600 };
const safeArea: BadgeEdgeInsets = { top: 20, left: 10, bottom: 34, right: 5 };
const badgeSize = { width: 200, height: 30 };
const metrics = AttributionBadgeLayoutMath.metrics("regular");

// A non-zero margin, so the frame math is exercised with all three offsets
// (safe area, margin, badge size) in play. The zero default is covered by
// the margin tests below.
function frame(position: AttributionPosition, isRightToLeft = false) {
  return AttributionBadgeLayoutMath.badgeFrame(badgeSize, position, bounds, safeArea, 12, isRightToLeft);
}

describe("AttributionBadgeLayoutMath", () => {
  /** `regular` keeps the historical text size and insets, so the default badge renders as it did. */
  test("regular metrics match the legacy constants", () => {
    expect(metrics).toEqual({ fontSize: 12, horizontalInset: 10, verticalInset: 7 });
  });

  test("metrics scale monotonically", () => {
    const small = AttributionBadgeLayoutMath.metrics("small");
    const regular = AttributionBadgeLayoutMath.metrics("regular");
    const large = AttributionBadgeLayoutMath.metrics("large");
    for (const [smaller, larger] of [
      [small, regular],
      [regular, large],
    ] as const) {
      expect(smaller.fontSize).toBeLessThan(larger.fontSize);
      expect(smaller.horizontalInset).toBeLessThan(larger.horizontalInset);
      expect(smaller.verticalInset).toBeLessThan(larger.verticalInset);
    }
  });

  test("the badge frame for every position", () => {
    // contentRect: x 22...783, y 32...554 (safe area + margin 12).
    expect(frame("bottomTrailing")).toEqual({ x: 783 - 200, y: 554 - 30, width: 200, height: 30 });
    expect(frame("bottomLeading")).toEqual({ x: 22, y: 554 - 30, width: 200, height: 30 });
    expect(frame("topTrailing")).toEqual({ x: 783 - 200, y: 32, width: 200, height: 30 });
    expect(frame("topLeading")).toEqual({ x: 22, y: 32, width: 200, height: 30 });
    expect(frame("bottomCenter")).toEqual({ x: (22 + 783) / 2 - 100, y: 554 - 30, width: 200, height: 30 });
    expect(frame("topCenter")).toEqual({ x: (22 + 783) / 2 - 100, y: 32, width: 200, height: 30 });
  });

  /** Right to left mirrors leading and trailing but never the centres. */
  test("right to left flips leading and trailing only", () => {
    expect(frame("bottomTrailing", true).x).toBe(frame("bottomLeading").x);
    expect(frame("topLeading", true).x).toBe(frame("topTrailing").x);
    expect(frame("bottomCenter", true)).toEqual(frame("bottomCenter"));
    expect(frame("topCenter", true)).toEqual(frame("topCenter"));
  });

  test("the available width subtracts the safe area and the margins", () => {
    expect(AttributionBadgeLayoutMath.availableWidth(bounds, safeArea, 12)).toBe(800 - 10 - 5 - 12 * 2);
  });

  /** The badge is the line and its insets. */
  test("the badge size is the line and its insets", () => {
    const size = AttributionBadgeLayoutMath.badgeSize({ width: 120, height: 15 }, metrics, 400);
    expect(size.height).toBe(Math.ceil(15 + metrics.verticalInset * 2));
    expect(size.width).toBe(Math.ceil(120 + metrics.horizontalInset * 2));
  });

  /**
   * A map under the safe area, as a full-screen page lays it out on a phone:
   * a bottom badge sits on the bottom edge by default, moved in from the
   * sides by the bottom inset, clear of the rounded corners.
   */
  test("a bottom badge sits on the bottom edge by default", () => {
    const phone = { top: 59, left: 0, bottom: 34, right: 0 };
    const insets = AttributionBadgeLayoutMath.badgeInsets(phone, "bottomTrailing", false);
    expect(insets).toEqual({ top: 59, left: 34, bottom: 0, right: 34 });

    const screen = { x: 0, y: 0, width: 402, height: 874 };
    const placed = AttributionBadgeLayoutMath.badgeFrame(badgeSize, "bottomTrailing", screen, insets, 0, false);
    expect(placed.y + placed.height).toBe(screen.height);
    expect(placed.x + placed.width).toBe(screen.width - 34);
  });

  /**
   * Respecting the bottom safe area, and every top position, keeps the
   * view's insets as they are. A side inset larger than the bottom one, a
   * phone in landscape, is kept too.
   */
  test("the safe area is kept where the badge respects it or sits at the top", () => {
    const phone = { top: 59, left: 0, bottom: 34, right: 0 };
    const respected = AttributionBadgeLayoutMath.badgeInsets(phone, "bottomCenter", true);
    expect(respected.bottom).toBe(34);
    expect(respected.left).toBe(0);

    const top = AttributionBadgeLayoutMath.badgeInsets(phone, "topLeading", false);
    expect(top.bottom).toBe(34);
    expect(top.top).toBe(59);

    const landscape = { top: 0, left: 59, bottom: 21, right: 59 };
    const sides = AttributionBadgeLayoutMath.badgeInsets(landscape, "bottomLeading", false);
    expect(sides.left).toBe(59);
    expect(sides.right).toBe(59);
    expect(sides.bottom).toBe(0);
  });

  /** A map inside the safe area has no bottom inset: nothing moves. */
  test("a map inside the safe area keeps its insets", () => {
    const inside = { top: 0, left: 0, bottom: 0, right: 0 };
    expect(AttributionBadgeLayoutMath.badgeInsets(inside, "bottomTrailing", false)).toEqual(inside);
  });

  /** The modifier sets the setting and leaves the rest of the badge alone. */
  test("the modifier sets the bottom safe area", () => {
    expect(ImmersiveMapSettings.default.attribution.respectsBottomSafeArea).toBe(false);
    const look = ImmersiveMapSettings.default.attributionSettings({ position: "bottomCenter" }).attributionSettings({ respectsBottomSafeArea: true }).attribution;
    expect(look.respectsBottomSafeArea).toBe(true);
    expect(look.position).toBe("bottomCenter");
  });

  /**
   * A line longer than the width it is given fills that width, and the
   * label cuts it: the line may run along the whole edge of the map and no
   * further.
   */
  test("the badge size clamps to the bounding width", () => {
    expect(AttributionBadgeLayoutMath.badgeSize({ width: 1000, height: 15 }, metrics, 400).width).toBe(400);
  });

  /** The line sits inside the insets. */
  test("the label frame is the badge less its insets", () => {
    const label = AttributionBadgeLayoutMath.labelFrame({ x: 0, y: 0, width: 150, height: 40 }, metrics);
    expect(label).toEqual({ x: metrics.horizontalInset, y: metrics.verticalInset, width: 150 - metrics.horizontalInset * 2, height: 40 - metrics.verticalInset * 2 });
  });
});

/**
 * The badge margin: the app-configured distance between the badge and the
 * view edges. The default is 0, so the badge sits tightly in its corner.
 * Raising it floats the badge over the map.
 */
describe("the attribution badge margin", () => {
  const marginBounds = { x: 0, y: 0, width: 400, height: 300 };
  const size = { width: 120, height: 24 };
  const zero = { top: 0, left: 0, bottom: 0, right: 0 };

  test("the default margin is zero", () => {
    expect(attributionSettings().margin).toBe(0);
    expect(ImmersiveMapSettings.default.attribution.margin).toBe(0);
  });

  test("a zero margin pins the badge into the corner", () => {
    const placed = AttributionBadgeLayoutMath.badgeFrame(size, "bottomTrailing", marginBounds, zero, 0, false);
    expect(placed.x + placed.width).toBe(marginBounds.width);
    expect(placed.y + placed.height).toBe(marginBounds.height);
  });

  test("a margin floats the badge off the edges", () => {
    const placed = AttributionBadgeLayoutMath.badgeFrame(size, "bottomTrailing", marginBounds, zero, 12, false);
    expect(placed.x + placed.width).toBe(marginBounds.width - 12);
    expect(placed.y + placed.height).toBe(marginBounds.height - 12);
  });

  test("the margin applies after the safe area", () => {
    const insets = { top: 20, left: 0, bottom: 34, right: 8 };
    const placed = AttributionBadgeLayoutMath.badgeFrame(size, "bottomTrailing", marginBounds, insets, 10, false);
    expect(placed.x + placed.width).toBe(marginBounds.width - 8 - 10);
    expect(placed.y + placed.height).toBe(marginBounds.height - 34 - 10);
  });

  test("the margin narrows the available width", () => {
    expect(AttributionBadgeLayoutMath.availableWidth(marginBounds, zero, 0)).toBe(marginBounds.width);
    expect(AttributionBadgeLayoutMath.availableWidth(marginBounds, zero, 15)).toBe(marginBounds.width - 30);
  });

  test("the margin builder touches only the margin", () => {
    const settings = ImmersiveMapSettings.default.attributionSettings({ margin: 12 });
    expect(settings.attribution.margin).toBe(12);
    expect(settings.attribution.position).toBe(defaultAttributionSettings.position);
    expect(settings.attribution.size).toBe(defaultAttributionSettings.size);
  });
});

/** The same rules as CSS over the page's safe area, which the browser resolves: nothing is measured. */
describe("the attribution badge's CSS placement", () => {
  const bottomInset = "env(safe-area-inset-bottom, 0px)";

  test("a trailing bottom badge sits on the bottom edge, in from the right by the margin and the wider of the side and bottom insets", () => {
    const placement = AttributionBadgeLayoutMath.cssPlacement("bottomTrailing", 8, false, false);
    expect(placement.bottom).toBe("8px");
    expect(placement.top).toBe("auto");
    expect(placement.left).toBe("auto");
    expect(placement.right).toBe(`calc(max(env(safe-area-inset-right, 0px), ${bottomInset}) + 8px)`);
    expect(placement.transform).toBe("none");
    expect(placement.maxWidth).toContain("- 16px");
  });

  test("respecting the bottom safe area lifts the badge above it and keeps the side insets", () => {
    const placement = AttributionBadgeLayoutMath.cssPlacement("bottomLeading", 0, true, false);
    expect(placement.bottom).toBe(`calc(${bottomInset} + 0px)`);
    expect(placement.left).toBe("calc(env(safe-area-inset-left, 0px) + 0px)");
    expect(placement.right).toBe("auto");
  });

  test("a top badge keeps the top safe area", () => {
    const placement = AttributionBadgeLayoutMath.cssPlacement("topLeading", 4, false, false);
    expect(placement.top).toBe("calc(env(safe-area-inset-top, 0px) + 4px)");
    expect(placement.bottom).toBe("auto");
    expect(placement.left).toBe("calc(env(safe-area-inset-left, 0px) + 4px)");
  });

  test("right to left flips leading and trailing but never the centres", () => {
    const leading = AttributionBadgeLayoutMath.cssPlacement("topLeading", 4, false, true);
    expect(leading.left).toBe("auto");
    expect(leading.right).toBe("calc(env(safe-area-inset-right, 0px) + 4px)");
    const trailing = AttributionBadgeLayoutMath.cssPlacement("bottomTrailing", 4, true, true);
    expect(trailing.right).toBe("auto");
    expect(trailing.left).toBe("calc(env(safe-area-inset-left, 0px) + 4px)");
    expect(AttributionBadgeLayoutMath.cssPlacement("bottomCenter", 4, false, true)).toEqual(AttributionBadgeLayoutMath.cssPlacement("bottomCenter", 4, false, false));
  });

  test("a centred badge stands on the middle of the content and translates back by half its width", () => {
    const placement = AttributionBadgeLayoutMath.cssPlacement("topCenter", 0, false, false);
    expect(placement.left).toBe("calc(50% + (env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)) / 2)");
    expect(placement.right).toBe("auto");
    expect(placement.transform).toBe("translateX(-50%)");
  });
});
