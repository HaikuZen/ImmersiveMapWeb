// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `RoadLabelPlacerTests` (the placement and instance
// box parts, the anchor point parts are in road-label-cache.test.ts): the CPU
// placement of road glyphs along their projected roads. The placer consumes
// already-projected screen points, so the tests feed hand-made projections
// and read the glyph placements. The regression under test: the label must
// centre on the anchor's own projected point, not on the anchor's world t
// lerped along the projected segment. That lerp is not a projection under a
// tilted perspective camera, and labels on long straight segments slid along
// the road while tilting.

import { describe, expect, test } from "vitest";
import { mat4FromColumns } from "../../math/matrix.ts";
import { RoadBoxBuffer, RoadLabelPlacement, RoadLabelPlacer, RoadLabelPlacerScratch, type RoadLabelGeometry } from "./road-label-placer.ts";

type Point = readonly [number, number];

interface PlaceOptions {
  readonly pathPoints: readonly Point[];
  readonly pathPointCount: number;
  readonly visible?: readonly boolean[];
  /** The anchor's segment and the index of its own point. */
  readonly anchor: readonly [number, number];
  readonly glyphCenters: readonly number[];
  readonly labelWidth?: number;
  readonly minLength?: number;
  readonly pixelsPerPoint?: number;
}

interface GlyphPlacement {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly visible: number;
}

/** One path of `pathPointCount` points followed by the anchor's own point, one instance with a glyph per centre. */
function place(options: PlaceOptions): { placements: GlyphPlacement[]; extrapolated: boolean[]; boxHalfSizes: Point[] } {
  const glyphCount = options.glyphCenters.length;
  const labelWidth = options.labelWidth ?? 100;
  const minLength = options.minLength ?? 100;
  const geometry: RoadLabelGeometry = {
    pathPoints: new Float32Array(options.pathPoints.length * 2),
    pathRanges: Int32Array.from([0, options.pathPointCount]),
    pathInstanceRanges: Int32Array.from([0, 1]),
    anchors: Int32Array.from([0, options.anchor[0], options.anchor[1]]),
    instanceGlyphRanges: Int32Array.from([0, glyphCount]),
    glyphs: Float32Array.from(options.glyphCenters.flatMap((center) => [center, 0, labelWidth, minLength])),
    glyphInstances: new Int32Array(glyphCount),
    glyphHalfSizes: Float32Array.from(options.glyphCenters.flatMap(() => [50, 10])),
    glyphCount,
  };
  const output = new RoadLabelPlacement();
  const visible = options.visible ?? options.pathPoints.map(() => true);
  RoadLabelPlacer.placeProjected(geometry, Float64Array.from(options.pathPoints.flat()), Uint8Array.from(visible.map(Number)), options.pixelsPerPoint ?? 1, new RoadLabelPlacerScratch(), output);
  const placements: GlyphPlacement[] = [];
  const boxHalfSizes: Point[] = [];
  for (let glyph = 0; glyph < glyphCount; glyph++) {
    const p = output.placements;
    placements.push({ x: p[glyph * 4]!, y: p[glyph * 4 + 1]!, angle: p[glyph * 4 + 2]!, visible: p[glyph * 4 + 3]! });
    boxHalfSizes.push([output.boxHalfSizes[glyph * 2]!, output.boxHalfSizes[glyph * 2 + 1]!]);
  }
  return { placements, extrapolated: Array.from(output.extrapolated, Boolean), boxHalfSizes };
}

/** A placement output written by hand: per glyph its position, angle and whether it is drawn, past an end and its box. */
function output(glyphs: readonly { readonly at: Point; readonly angle: number; readonly visible?: boolean; readonly extrapolated?: boolean; readonly half: Point }[]): RoadLabelPlacement {
  const result = new RoadLabelPlacement();
  result.resize(glyphs.length);
  glyphs.forEach((glyph, index) => {
    result.placements.set([glyph.at[0], glyph.at[1], glyph.angle, glyph.visible === false ? 0 : 1], index * 4);
    result.extrapolated[index] = glyph.extrapolated === true ? 1 : 0;
    result.boxHalfSizes.set(glyph.half, index * 2);
  });
  return result;
}

function centers(boxes: RoadBoxBuffer): Point[] {
  return Array.from({ length: boxes.count }, (_, index): Point => [boxes.centers[index * 2]!, boxes.centers[index * 2 + 1]!]);
}

describe("RoadLabelPlacer placement", () => {
  test("a glyph centres on the projected anchor point", () => {
    // Straight horizontal path, 1000 px on screen. The anchor's own
    // projection sits at x = 400: under a tilted camera a world-space
    // mid-segment anchor lands off the screen-length midpoint (x = 600 for
    // the old t = 0.5 lerp), and the label must follow the projection.
    const result = place({ pathPoints: [[100, 300], [1100, 300], [400, 300]], pathPointCount: 2, anchor: [0, 2], glyphCenters: [50, 10] });
    const [first, second] = result.placements;
    expect(first!.visible).toBe(1);
    expect(result.extrapolated[0]).toBe(false);
    expect(first!.x).toBeCloseTo(400, 2);
    expect(first!.y).toBeCloseTo(300, 2);
    expect(first!.angle).toBeCloseTo(0, 5);
    // The second glyph keeps its pixel offset from the anchored centre.
    expect(second!.visible).toBe(1);
    expect(second!.x).toBeCloseTo(360, 2);
    // An upright glyph's box is its own half size.
    expect(result.boxHalfSizes[0]![0]).toBeCloseTo(50, 4);
    expect(result.boxHalfSizes[0]![1]).toBeCloseTo(10, 4);
  });

  // A stitched road that hooks back at a junction: the path runs right along
  // the label's segment and then turns hard back left, so its chord points
  // left. The text reads along its own span, rightward, not along the chord.
  test("the reading direction follows the label's span, not the path's chord", () => {
    const result = place({ pathPoints: [[100, 300], [700, 300], [0, 900], [400, 300]], pathPointCount: 3, anchor: [0, 3], glyphCenters: [50, 10] });
    expect(result.placements[0]!.visible).toBe(1);
    expect(Math.cos(result.placements[0]!.angle), "upright along a rightward span").toBeCloseTo(1, 5);
    expect(result.placements[1]!.x, "the left glyph sits to the left").toBeCloseTo(360, 2);
  });

  // The mirror case: the label's segment runs left while the chord of the
  // hooked path points right. The text is turned to read, so the left glyph
  // of the label still lands on the left of the screen.
  test("a leftward span turns the text whatever the chord says", () => {
    const result = place({ pathPoints: [[700, 300], [100, 300], [800, 900], [400, 300]], pathPointCount: 3, anchor: [0, 3], glyphCenters: [50, 10] });
    expect(result.placements[0]!.visible).toBe(1);
    expect(Math.cos(result.placements[0]!.angle), "turned by a half turn to read upright").toBeCloseTo(1, 5);
    expect(result.placements[1]!.x, "the left glyph still sits to the left").toBeCloseTo(360, 2);
  });

  test("an invisible anchor point hides the label", () => {
    const result = place({ pathPoints: [[100, 300], [1100, 300], [0, 0]], pathPointCount: 2, visible: [true, true, false], anchor: [0, 2], glyphCenters: [50] });
    expect(result.placements[0]!.visible).toBe(0);
  });

  test("a path point behind the camera hides every label on the path", () => {
    const result = place({ pathPoints: [[100, 300], [1100, 300], [400, 300]], pathPointCount: 2, visible: [true, false, true], anchor: [0, 2], glyphCenters: [50] });
    expect(result.placements[0]!.visible).toBe(0);
  });

  test("a path shorter than the label draws nothing", () => {
    const result = place({ pathPoints: [[100, 300], [180, 300], [140, 300]], pathPointCount: 2, anchor: [0, 2], glyphCenters: [50], minLength: 100 });
    expect(result.placements[0]!.visible).toBe(0);
    expect(result.boxHalfSizes[0]).toEqual([0, 0]);
  });

  // A label wider than the road overhangs an end: the glyph past the end is
  // drawn on the road's line, but marked so the solve never offers the
  // instance.
  test("a glyph past the path end is extrapolated", () => {
    const result = place({ pathPoints: [[100, 300], [160, 300], [130, 300]], pathPointCount: 2, anchor: [0, 2], glyphCenters: [10, 90], labelWidth: 100, minLength: 0 });
    expect(result.placements[0]!.x).toBeCloseTo(90, 2);
    expect(result.extrapolated[0]).toBe(true);
    expect(result.placements[1]!.x).toBeCloseTo(170, 2);
    expect(result.extrapolated[1]).toBe(true);
  });

  // The screen path is in device pixels and the glyph metrics in points: the
  // offsets scale with the display.
  test("glyph offsets scale with the pixels per point", () => {
    const result = place({ pathPoints: [[100, 300], [1100, 300], [400, 300]], pathPointCount: 2, anchor: [0, 2], glyphCenters: [50, 10], pixelsPerPoint: 2 });
    expect(result.placements[1]!.x).toBeCloseTo(320, 2);
    expect(result.boxHalfSizes[0]![0]).toBeCloseTo(100, 4);
  });

  test("a turned glyph's box is the rotated box's bounds", () => {
    const result = place({ pathPoints: [[100, 100], [100, 1100], [100, 400]], pathPointCount: 2, anchor: [0, 2], glyphCenters: [50] });
    expect(result.boxHalfSizes[0]![0]).toBeCloseTo(10, 4);
    expect(result.boxHalfSizes[0]![1]).toBeCloseTo(50, 4);
  });
});

describe("RoadLabelPlacer projection", () => {
  // A path point deeper than the reach is not visible, as one behind the
  // camera is not, so a glyph on it is not placed.
  test("a point past the reach is not visible", () => {
    // The clip w grows with the world y: 1 at the tile's south edge, 11 at its north edge.
    const matrix = mat4FromColumns([1, 0, 0, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]);
    const points = Float32Array.from([0.5, 1, 0.5, 0]);
    const scratch = new RoadLabelPlacerScratch();
    RoadLabelPlacer.project(points, [0, 0, 10], matrix, 100, 100, 5, scratch);
    expect(Array.from(scratch.visible.subarray(0, 2))).toEqual([1, 0]);

    RoadLabelPlacer.project(points, [0, 0, 10], matrix, 100, 100, Infinity, scratch);
    expect(Array.from(scratch.visible.subarray(0, 2)), "no reach keeps every point in front of the camera").toEqual([1, 1]);
  });

  test("a point lands in device pixels, origin bottom left", () => {
    const identity = mat4FromColumns([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);
    const scratch = new RoadLabelPlacerScratch();
    // uv (0.75, 0.25) of a tile at (-1, -1) two units wide is (0.5, 0.5).
    RoadLabelPlacer.project(Float32Array.from([0.75, 0.25]), [-1, -1, 2], identity, 200, 100, Infinity, scratch);
    expect(Array.from(scratch.screenPoints.subarray(0, 2))).toEqual([150, 75]);
  });
});

describe("RoadLabelPlacer instance boxes", () => {
  test("the instance boxes come from the placement", () => {
    const placed = output([
      { at: [10, 20], angle: 0.1, half: [4, 6] },
      { at: [30, 40], angle: 0.2, half: [5, 7] },
      { at: [99, 99], angle: 0.3, half: [1, 1] },
    ]);
    const boxes = new RoadBoxBuffer();
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, placed, 1, boxes)).toBe(true);
    expect(centers(boxes)).toEqual([
      [10, 20],
      [30, 40],
    ]);
    expect(Array.from(boxes.halfSizes.subarray(0, 4))).toEqual([4, 6, 5, 7]);
  });

  // All or nothing: a hidden glyph, one past a path end, or a sharp turn
  // between neighbours cancels the instance and leaves nothing appended.
  test("an instance is rejected whole", () => {
    const boxes = new RoadBoxBuffer();
    boxes.push(1, 1, 1, 1);

    const hidden = output([
      { at: [10, 20], angle: 0, half: [4, 6] },
      { at: [0, 0], angle: 0, visible: false, half: [0, 0] },
    ]);
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, hidden, 1, boxes)).toBe(false);
    expect(boxes.count, "nothing of the rejected instance stays").toBe(1);

    const overhanging = output([
      { at: [10, 20], angle: 0, half: [4, 6] },
      { at: [30, 40], angle: 0, extrapolated: true, half: [0, 0] },
    ]);
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, overhanging, 1, boxes)).toBe(false);

    const turning = output([
      { at: [10, 20], angle: 0, half: [4, 6] },
      { at: [30, 40], angle: 1.2, half: [0, 0] },
    ]);
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, turning, 1, boxes)).toBe(false);
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, turning, 1.5, boxes)).toBe(true);
    expect(boxes.count).toBe(3);
  });

  // Angles of plus and minus pi are the same turn (reverse adds pi): after
  // normalization the delta is small and the instance stays.
  test("the turn test normalizes around pi", () => {
    const placed = output([
      { at: [10, 20], angle: Math.PI - 0.05, half: [4, 6] },
      { at: [30, 40], angle: -Math.PI + 0.05, half: [5, 7] },
    ]);
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, placed, 0.5, new RoadBoxBuffer())).toBe(true);
  });

  test("an out of bounds range gets no decision", () => {
    const placed = output([{ at: [10, 20], angle: 0, half: [4, 6] }]);
    const boxes = new RoadBoxBuffer();
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 2, placed, 1, boxes)).toBe(false);
    expect(RoadLabelPlacer.appendInstanceBoxes(0, 0, placed, 1, boxes)).toBe(false);
  });

  test("the box buffer grows past its first size", () => {
    const boxes = new RoadBoxBuffer();
    for (let index = 0; index < 300; index++) boxes.push(index, index + 1, 2, 3);
    expect(boxes.count).toBe(300);
    expect([boxes.centers[598], boxes.centers[599], boxes.halfSizes[599]]).toEqual([299, 300, 3]);
  });
});
