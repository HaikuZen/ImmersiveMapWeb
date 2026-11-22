// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The values the pin collision layout takes and gives (the Swift
 * `ProjectedPin`, `PinCollisionItem`, `PinFlowerGroup`,
 * `PinCollisionGeometry` and `PinCollisionLayout`), shared by the solver,
 * the fade store and the renderer. Screen points are in drawable pixels,
 * origin bottom-left. Times are seconds.
 */

import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import type { ImmersiveMapPin } from "../immersive-map-pin.ts";
import { clamp } from "./pin-collision-math.ts";

/** A pin projected onto the screen, before collision resolution. */
export interface ProjectedPin {
  readonly pin: ImmersiveMapPin;
  readonly squashScaleX: number;
  readonly squashScaleY: number;
  readonly screenPoint: ScreenPointOutput;
  /**
   * The anchor's world (normalized Mercator) position: a pan-stable basis
   * for splitting sprawling piles with the world grid.
   */
  readonly worldX: number;
  readonly worldY: number;
  readonly drawOrder: number;
}

/**
 * Placement of one pin: the displaced screen point, the true anchor (the
 * projection of the geo position) and the current shape (a pin in place or a
 * displaced circle).
 */
export interface PinCollisionItem {
  readonly pin: ImmersiveMapPin;
  readonly squashScaleX: number;
  readonly squashScaleY: number;
  readonly screenPoint: ScreenPointOutput;
  readonly anchorScreenPoint: ScreenPointOutput;
  readonly displayScale: number;
  readonly morph: number;
  /** A flower petal: it sits in its ring slot and is not moved by corrections. */
  readonly isFlowerPetal: boolean;
  readonly drawOrder: number;
}

/**
 * A flower's membership and visible petals. The flower is drawn with
 * ordinary pin items, this exists for introspection and tests.
 */
export interface PinFlowerGroup {
  readonly memberIDs: readonly number[];
  readonly visibleMemberIDs: readonly number[];
  readonly centerX: number;
  readonly centerY: number;
}

/**
 * The screen geometry of a pin the solver needs. The body is offset up
 * from the anchor (the pin's bottom stands on the geo point), so collisions
 * are resolved on body centers, not anchors.
 */
export interface PinCollisionGeometry {
  /** Full pin size, for the grouping thresholds. */
  readonly pinSizePx: number;
  /** Pin body radius at scale 1 (half the width of the rounded square). */
  readonly bodyRadiusPx: number;
  /** Visible circle radius (morph 1) at scale 1: the body's inscribed circle. */
  readonly circleBodyRadiusPx: number;
  /** Shift of the body center from the anchor at scale 1. */
  readonly bodyCenterOffsetX: number;
  readonly bodyCenterOffsetY: number;
}

/**
 * Nominal body radius for the current shape: the pin is wider than the
 * circle, and computing from the pin radius would leave a visible gap
 * between circles.
 */
export function pinCollisionBodyRadius(geometry: PinCollisionGeometry, morph: number): number {
  return geometry.bodyRadiusPx + (geometry.circleBodyRadiusPx - geometry.bodyRadiusPx) * clamp(morph, 0, 1);
}

export const PinCollisionGeometry = Object.freeze({
  bodyRadius: pinCollisionBodyRadius,
});

export interface PinCollisionLayout {
  readonly pinItems: readonly PinCollisionItem[];
  readonly flowerGroups: readonly PinFlowerGroup[];
  readonly hasActiveAnimations: boolean;
}

const emptyLayout: PinCollisionLayout = Object.freeze({ pinItems: Object.freeze([]), flowerGroups: Object.freeze([]), hasActiveAnimations: false });

export const PinCollisionLayout = Object.freeze({
  empty: emptyLayout,
  /**
   * Every pin exactly on its coordinate, at full size, in its draw order:
   * the layout of a map whose pins do not spread apart
   * (`PinSettings.spreadsApart`). Nothing is pushed, so nothing moves
   * between frames and no pin has a beam.
   */
  anchored(projectedPins: readonly ProjectedPin[]): PinCollisionLayout {
    const items = [...projectedPins]
      .sort((a, b) => a.drawOrder - b.drawOrder)
      .map(
        (projected): PinCollisionItem => ({
          pin: projected.pin,
          squashScaleX: projected.squashScaleX,
          squashScaleY: projected.squashScaleY,
          screenPoint: projected.screenPoint,
          anchorScreenPoint: projected.screenPoint,
          displayScale: 1,
          morph: 0,
          isFlowerPetal: false,
          drawOrder: projected.drawOrder,
        }),
      );
    return { pinItems: items, flowerGroups: [], hasActiveAnimations: false };
  },
});

/**
 * A projected pin with the world position derived from the screen, the
 * Swift `ProjectedPin` fallback for synthetic calls (tests and benchmarks):
 * any linear mapping of the screen into the world is consistent with the
 * grid split.
 */
export function projectedPinFromScreen(pin: ImmersiveMapPin, screenPoint: ScreenPointOutput, drawOrder: number, squashScaleX = 1, squashScaleY = 1): ProjectedPin {
  return { pin, squashScaleX, squashScaleY, screenPoint, worldX: screenPoint.positionX * 0.001, worldY: screenPoint.positionY * 0.001, drawOrder };
}
