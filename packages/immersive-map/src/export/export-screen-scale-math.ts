// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pixels per point an offscreen export renders at, a port of the Swift
 * `ExportScreenScaleMath`.
 *
 * An export has no screen to ask, but it still has to choose how big a
 * point is, because that decides how large the labels and the pins come out
 * against the frame. At 1 a 1080p frame would be sized as a 1920 by 1080
 * point page, about twice the width of a laptop screen, and the labels
 * would come out half the size a viewer expects.
 *
 * The rule is the one a screen follows: keep the point canvas the same and
 * spend the extra resolution on detail. A 4K export is then the same
 * composition as a 1080p one, rendered sharper, rather than the same frame
 * with twice as much map in it.
 */
export const ExportScreenScaleMath = {
  /**
   * The short side of the point canvas an export is composed for. 1080p
   * lands on 2 pixels per point, the still's default and what a
   * high-density screen of that size reports.
   */
  referenceShortSidePoints: 540,
  /** The pixels per point of the reference screen (the Swift `ScreenScale.reference`). */
  referencePixelsPerPoint: 2,
  /**
   * Keeps a small thumbnail from rendering at a fraction of a pixel per
   * point, and a very large frame from asking for a scale no atlas is sized for.
   */
  supportedRange: { lowerBound: 1, upperBound: 8 } as const,

  pixelsPerPoint(width: number, height: number): number {
    const shortSidePixels = Math.min(width, height);
    if (!Number.isFinite(shortSidePixels) || !(shortSidePixels > 0)) return ExportScreenScaleMath.referencePixelsPerPoint;
    const scale = shortSidePixels / ExportScreenScaleMath.referenceShortSidePoints;
    return Math.min(Math.max(scale, ExportScreenScaleMath.supportedRange.lowerBound), ExportScreenScaleMath.supportedRange.upperBound);
  },

  /**
   * The pixels per point an annotation is rasterized at. Annotations are
   * point-sized on the live map, so an export grows them with its own scale
   * or they shrink against the labels beside them. `annotationScale` is
   * stated against the reference screen, so its default of 2 lands exactly
   * on the map's scale and anything above it oversamples.
   */
  annotationRasterizationScale(annotationScale: number, width: number, height: number): number {
    return (ExportScreenScaleMath.pixelsPerPoint(width, height) / ExportScreenScaleMath.referencePixelsPerPoint) * annotationScale;
  },
} as const;
