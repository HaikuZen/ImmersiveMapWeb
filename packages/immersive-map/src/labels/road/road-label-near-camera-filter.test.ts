// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `RoadLabelNearCameraFilterTests`: the road label
// filter by visible screen area. The tile quad is clipped against the near
// plane and the viewport, and the metrics are taken on the visible part. The
// viewport is 1000 by 1000: NDC x and y of -1 to 1 map to 0 to 1000 px, at
// two pixels per point, the Swift reference screen scale. The threshold in
// points is ported from the Swift `LabelScreenUnitTests`.

import { describe, expect, test } from "vitest";
import { mat4FromColumns } from "../../math/matrix.ts";
import prepare from "../subsystems/base-label-prepare.ts?raw";
import filter from "./road-label-near-camera-filter.ts?raw";
import { RoadLabelNearCameraFilter } from "./road-label-near-camera-filter.ts";

type Clip = [number, number, number, number];

/** The clip coordinate of a point at screen position (x, y) px at w, on a 1000 by 1000 viewport. */
function clipPoint(x: number, y: number, w = 1): Clip {
  return [((x / 1000) * 2 - 1) * w, ((y / 1000) * 2 - 1) * w, 0, w];
}

function quad(minX: number, minY: number, maxX: number, maxY: number): Clip[] {
  return [clipPoint(minX, minY), clipPoint(maxX, minY), clipPoint(maxX, maxY), clipPoint(minX, maxY)];
}

function keeps(corners: Clip[], underzoomLevels = 0, pixelsPerPoint = 2): boolean {
  return RoadLabelNearCameraFilter.shouldKeepTile(corners, 1000, 1000, pixelsPerPoint, underzoomLevels);
}

describe("RoadLabelNearCameraFilter", () => {
  test("the filter and the frame use no path or anchor culling", () => {
    for (const source of [filter, prepare]) {
      expect(source).not.toContain("shouldKeepPath");
      expect(source).not.toContain("shouldKeepAnchor");
    }
  });

  test("a large fully visible tile is kept", () => {
    // A quad of about 700 by 700 px, undistorted.
    expect(keeps(quad(100, 100, 800, 800))).toBe(true);
  });

  test("a small undistorted tile is rejected", () => {
    // A 200 by 200 px square is below the area threshold.
    expect(keeps(quad(100, 100, 300, 300))).toBe(false);
  });

  test("the area threshold is in points, so it scales with the display", () => {
    expect(keeps(quad(100, 100, 300, 300), 0, 1)).toBe(true);
    expect(keeps(quad(100, 100, 800, 800), 0, 5)).toBe(false);
  });

  test("a ribbon failing the compression ratio is rejected", () => {
    // A diagonal ribbon of about 1300 by 80 px inside the viewport: the 103k
    // area passes, but the ratio 103k / 1300^2 = 0.06 reveals a strip
    // flattened by perspective.
    expect(keeps([clipPoint(60, 20), clipPoint(980, 940), clipPoint(924, 996), clipPoint(4, 76)])).toBe(false);
  });

  test("a near tile crossing the camera plane is kept", () => {
    // Near corners behind the camera (w < 0): clipping against the near plane
    // keeps the visible half, and it is huge. The tile is kept, and the
    // degenerate corner projections do not affect the decision.
    expect(keeps([clipPoint(-400, 900), clipPoint(1400, 900), [0.4, -0.6, 0, -0.5], [-0.4, -0.6, 0, -0.5]])).toBe(true);
  });

  test("a tile fully behind the camera is rejected", () => {
    const behind: Clip = [0.2, 0.2, 0, -1];
    expect(keeps([behind, behind, behind, behind])).toBe(false);
  });

  test("a degenerate input is rejected", () => {
    expect(keeps(quad(100, 100, 800, 800).slice(0, 3))).toBe(false);
    expect(RoadLabelNearCameraFilter.shouldKeepTile(quad(100, 100, 800, 800), 0, 1000)).toBe(false);
    expect(RoadLabelNearCameraFilter.shouldKeepTile(quad(100, 100, 800, 800), Number.NaN, 1000)).toBe(false);
  });

  test("an underzoomed tile requires more visible area per content", () => {
    // A 700 by 700 quad (490k px): enough for the exact tile, but for a
    // parent two levels coarser the area per content, 490k / 16 = 30.6k, is
    // below the 40k px threshold: its world is squeezed 16 times and labels
    // along roads are degenerate.
    const corners = quad(100, 100, 800, 800);
    expect(keeps(corners, 0)).toBe(true);
    expect(keeps(corners, 2)).toBe(false);
  });

  test("a near coarse parent passes with a large visible area", () => {
    // A near parent one level coarser covering almost the entire screen: the
    // visible area per content is sufficient (900k / 4 > threshold).
    expect(keeps(quad(20, 20, 980, 980), 1)).toBe(true);
  });

  test("the visible area is clipped by the viewport", () => {
    // A giant quad far beyond the screen: the decision is driven not by the
    // full projection (17000 by 200 = 3.4M px) but by the visible part, 1000
    // by 200 = 200k px. That is enough for the exact tile, but a parent two
    // levels coarser no longer has enough area per content (200k / 16 =
    // 12.5k): without the clip it would have passed (3.4M / 16 = 212k).
    const corners = quad(-8000, 400, 9000, 600);
    expect(keeps(corners, 0)).toBe(true);
    expect(keeps(corners, 2)).toBe(false);
  });

  test("the tile corners run north-west, north-east, south-east, south-west", () => {
    const identity = mat4FromColumns([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);
    // The flat render world is y up: the tile's north edge is its origin's y plus its size.
    expect(RoadLabelNearCameraFilter.flatTileClipCorners(identity, 10, 20, 4)).toEqual([
      [10, 24, 0, 1],
      [14, 24, 0, 1],
      [14, 20, 0, 1],
      [10, 20, 0, 1],
    ]);
  });

  // A tile square that just clears the threshold at 2x must also clear it at
  // 3x once the square grows with the display, and must fail at both scales
  // when it is smaller than the threshold in points.
  test("the road tile area threshold is expressed in points", () => {
    const keepsSquare = (sidePoints: number, pixelsPerPoint: number): boolean => {
      const sidePixels = sidePoints * pixelsPerPoint;
      const viewport = Math.max(sidePixels * 2, 1000);
      const half = sidePixels / viewport;
      const corners: Clip[] = [
        [-half, -half, 0, 1],
        [half, -half, 0, 1],
        [half, half, 0, 1],
        [-half, half, 0, 1],
      ];
      return RoadLabelNearCameraFilter.shouldKeepTile(corners, viewport, viewport, pixelsPerPoint);
    };
    expect(keepsSquare(200, 2)).toBe(true);
    expect(keepsSquare(200, 3)).toBe(true);
    expect(keepsSquare(100, 2)).toBe(false);
    expect(keepsSquare(100, 3)).toBe(false);
  });
});
