// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `AnnotationOverlayLayoutMathTests`: projection drawable pixels
// (origin at bottom left, y up) into CSS pixels (origin at top left), and
// placement by the unit anchor, with the CSS form of the placement added.

import { describe, expect, test } from "vitest";
import { AnnotationOverlayLayoutMath } from "./annotation-overlay-layout-math.ts";

const drawHeight = 600;

describe("AnnotationOverlayLayoutMath", () => {
  test("a point from pixels flips y and divides by the scale", () => {
    expect(AnnotationOverlayLayoutMath.pointFromPixel(400, 150, drawHeight, 2)).toEqual({ x: 200, y: 225 });
  });

  test("a scale of one keeps the pixels", () => {
    expect(AnnotationOverlayLayoutMath.pointFromPixel(400, 150, drawHeight, 1)).toEqual({ x: 400, y: 450 });
  });

  test("a scale of three", () => {
    expect(AnnotationOverlayLayoutMath.pointFromPixel(300, 0, drawHeight, 3)).toEqual({ x: 100, y: 200 });
  });

  test("a zero scale gives the origin", () => {
    expect(AnnotationOverlayLayoutMath.pointFromPixel(400, 150, drawHeight, 0)).toEqual({ x: 0, y: 0 });
  });

  test("the centre anchor centres the box on the point", () => {
    expect(AnnotationOverlayLayoutMath.frame({ x: 100, y: 100 }, 40, 20, { x: 0.5, y: 0.5 })).toEqual({ x: 80, y: 90, width: 40, height: 20 });
  });

  test("the bottom anchor puts the bottom centre on the point", () => {
    expect(AnnotationOverlayLayoutMath.frame({ x: 100, y: 100 }, 40, 20, { x: 0.5, y: 1 })).toEqual({ x: 80, y: 80, width: 40, height: 20 });
  });

  test("the top leading anchor puts the origin on the point", () => {
    expect(AnnotationOverlayLayoutMath.frame({ x: 100, y: 100 }, 40, 20, { x: 0, y: 0 })).toEqual({ x: 100, y: 100, width: 40, height: 20 });
  });

  /** The transform moves the box's origin to the point, then back by the anchor's share of its own size. */
  test("the CSS transform moves to the point and back by the anchor", () => {
    expect(AnnotationOverlayLayoutMath.cssTransform({ x: 100, y: 50.256 }, { x: 0.5, y: 0.5 })).toBe("translate3d(100px, 50.26px, 0) translate(-50%, -50%)");
    expect(AnnotationOverlayLayoutMath.cssTransform({ x: 100, y: 100 }, { x: 0.5, y: 1 })).toBe("translate3d(100px, 100px, 0) translate(-50%, -100%)");
    expect(AnnotationOverlayLayoutMath.cssTransform({ x: 100, y: 100 }, { x: 0, y: 0 })).toBe("translate3d(100px, 100px, 0) translate(0%, 0%)");
  });
});
