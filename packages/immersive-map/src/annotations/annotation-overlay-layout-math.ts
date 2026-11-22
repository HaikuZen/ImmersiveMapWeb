// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** A point in CSS pixels of the map, top-left origin, y down. */
export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Which point of an annotation stands on its coordinate, in the unit square
 * of the annotation's box: `{ x: 0, y: 0 }` is the top left corner,
 * `{ x: 0.5, y: 1 }` the middle of the bottom edge. The centre by default.
 */
export interface AnnotationAnchor {
  readonly x: number;
  readonly y: number;
}

/** An annotation's box in CSS pixels, top-left origin. */
export interface AnnotationFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const center: AnnotationAnchor = Object.freeze({ x: 0.5, y: 0.5 });

/** Rounds a CSS pixel to a hundredth: finer than any screen, and shorter strings. */
function cssPixel(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rounds a percentage to a thousandth. */
function cssPercent(value: number): number {
  return Math.round(value * 100_000) / 1000;
}

/**
 * Pure layout math of the annotation overlay (Swift
 * `AnnotationOverlayLayoutMath`): from the projection's drawable pixels to
 * CSS pixels, and anchor-based placement.
 */
export const AnnotationOverlayLayoutMath = Object.freeze({
  /**
   * Below this alpha an annotation near the globe's horizon takes no
   * pointer events. Any visible annotation is interactive.
   */
  interactionAlphaThreshold: 0.0001,

  /** The default anchor: the annotation's centre stands on its coordinate. */
  center,

  /**
   * The projection yields drawable pixels with a bottom-left origin and y
   * up, while the overlay lives in CSS pixels with a top-left origin:
   * x = px / scale, y = (drawHeight - py) / scale, where the scale is the
   * drawable's pixels per CSS pixel. A scale of zero or less gives the origin.
   */
  pointFromPixel(positionX: number, positionY: number, drawHeight: number, contentsScale: number): AnnotationPoint {
    if (!(contentsScale > 0)) {
      return { x: 0, y: 0 };
    }
    return { x: positionX / contentsScale, y: (drawHeight - positionY) / contentsScale };
  },

  /**
   * Frames the annotation so the `anchor` point of its box lands on the
   * projected point: origin = point - anchor * size.
   */
  frame(anchorPoint: AnnotationPoint, width: number, height: number, anchor: AnnotationAnchor): AnnotationFrame {
    return { x: anchorPoint.x - width * anchor.x, y: anchorPoint.y - height * anchor.y, width, height };
  },

  /**
   * `frame` as a CSS transform of an element whose box starts at the
   * overlay's origin: the move to the point, then the anchor's share of the
   * element's own size, which CSS percentages of `translate` measure. The
   * browser applies the size, so the map never reads the element's layout.
   */
  cssTransform(anchorPoint: AnnotationPoint, anchor: AnnotationAnchor): string {
    return `translate3d(${cssPixel(anchorPoint.x)}px, ${cssPixel(anchorPoint.y)}px, 0) translate(${cssPercent(-anchor.x)}%, ${cssPercent(-anchor.y)}%)`;
  },

  anchorsEqual(a: AnnotationAnchor, b: AnnotationAnchor): boolean {
    return a.x === b.x && a.y === b.y;
  },
});
