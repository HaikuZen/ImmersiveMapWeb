// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { VideoExportAnnotationCompositorMath } from "./video-export-annotation-overlay.ts";

/**
 * Ported from the Swift `VideoExportAnnotationCompositorMathTests`: the
 * placement in the bottom-up pixel space of the annotation projection, an
 * anchor's y measured from the annotation's top.
 */
describe("VideoExportAnnotationCompositorMath", () => {
  const [x, y, width, height] = [100, 200, 80, 40];

  test("the centre anchor centres the image on the point", () => {
    expect(VideoExportAnnotationCompositorMath.rectPx(x, y, width, height, { x: 0.5, y: 0.5 })).toEqual({ x: 60, y: 180, width: 80, height: 40 });
  });

  test("the bottom anchor puts the image above the point", () => {
    // The bottom edge touches the point and the image extends upward: in y-up space the rectangle starts at the point.
    expect(VideoExportAnnotationCompositorMath.rectPx(x, y, width, height, { x: 0.5, y: 1 })).toEqual({ x: 60, y: 200, width: 80, height: 40 });
  });

  test("the top-leading anchor puts the image below and right of the point", () => {
    expect(VideoExportAnnotationCompositorMath.rectPx(x, y, width, height, { x: 0, y: 0 })).toEqual({ x: 100, y: 160, width: 80, height: 40 });
  });

  test("a rectangle turns into the 2D canvas's top-down space", () => {
    // A 1000 pixel high frame: the rectangle 160...200 from the bottom is 800...840 from the top.
    expect(VideoExportAnnotationCompositorMath.canvasRect({ x: 100, y: 160, width: 80, height: 40 }, 1000)).toEqual({ x: 100, y: 800, width: 80, height: 40 });
  });
});
