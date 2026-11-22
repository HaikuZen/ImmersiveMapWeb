// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ExportScreenScaleMath } from "./export-screen-scale-math.ts";

/** Ported from the export cases of the Swift `LabelScreenUnitTests`. */
describe("ExportScreenScaleMath", () => {
  test("an export picks a scale that keeps the composition", () => {
    // 1080p composes for the point canvas a high-density screen of that size
    // gives, and 4K spends the extra resolution on detail instead of on map.
    expect(ExportScreenScaleMath.pixelsPerPoint(1920, 1080)).toBeCloseTo(2, 4);
    expect(ExportScreenScaleMath.pixelsPerPoint(3840, 2160)).toBeCloseTo(4, 4);
    // A 9:16 frame is measured on its short side: a vertical export gets the landscape one's label density.
    expect(ExportScreenScaleMath.pixelsPerPoint(1080, 1920)).toBeCloseTo(2, 4);
    expect(ExportScreenScaleMath.pixelsPerPoint(320, 240)).toBeCloseTo(ExportScreenScaleMath.supportedRange.lowerBound, 4);
    expect(ExportScreenScaleMath.pixelsPerPoint(0, 0)).toBeCloseTo(2, 4);
  });

  test("the annotations rasterize at the map's scale", () => {
    // The default states the reference scale, so it lands on the map's own.
    expect(ExportScreenScaleMath.annotationRasterizationScale(2, 1920, 1080)).toBeCloseTo(ExportScreenScaleMath.pixelsPerPoint(1920, 1080), 4);
    expect(ExportScreenScaleMath.annotationRasterizationScale(2, 3840, 2160)).toBeCloseTo(ExportScreenScaleMath.pixelsPerPoint(3840, 2160), 4);
    expect(ExportScreenScaleMath.annotationRasterizationScale(2, 1920, 1080)).toBeCloseTo(2, 4);
    // Above the default it oversamples, in step with the map rather than instead of it.
    expect(ExportScreenScaleMath.annotationRasterizationScale(3, 3840, 2160)).toBeCloseTo(6, 4);
  });
});
