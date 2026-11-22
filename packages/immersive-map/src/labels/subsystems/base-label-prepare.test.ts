// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The frame's label decisions as a whole (the Swift
// `BaseLabelPrepareSubsystem`, whose rules the ported tests of its parts pin
// one by one): fake tiles placed under a camera that maps the render world
// straight to clip space, frames stepped by time, the fades and the
// collision decisions read back. The collision boxes and grid in points are
// ported from the Swift `LabelScreenUnitTests`.

import { describe, expect, test } from "vitest";
import type { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { defaultLabelSettings } from "../../configuration/label-settings.ts";
import { mat4FromColumns } from "../../math/matrix.ts";
import { BuildingRiseCoverage } from "../../tile/placement/building-rise-coverage.ts";
import { makePlaceTile, type PlaceTile } from "../../tile/placement/place-tile.ts";
import type { RoadLabelsMeta, TextLabelPlacementInput } from "../../tile/store/prepared-labels.ts";
import type { GpuTile } from "../../tile/store/tile-gpu.ts";
import type { Tile } from "../../tile/tile.ts";
import { LabelFrameRecordLayout as L, type LabelSourceTile } from "../base/base-label-cache.ts";
import { makeTileTextLabels } from "../base/tile-text-labels.ts";
import { BaseLabelTraceRecorder } from "../../render/debug/base-label-trace-recorder.ts";
import { BaseLabelPrepare, emptyLabelDebugBoxes, type LabelFrameInput } from "./base-label-prepare.ts";

interface Label {
  readonly uv: readonly [number, number];
  readonly key: number;
  readonly priority?: number;
  readonly minZoom?: number;
}

const emptyRoad: RoadLabelsMeta = { pathInputs: [], pathRanges: [], pathLabels: [], labelStyle: null, glyphBounds: [], glyphBoundRanges: [], sizes: [], anchorRanges: [], anchors: [] };

/** A road named along v = 0.5 from u = 0.1 to u = 0.9, one anchor in its middle, two glyphs. */
const straightRoad: RoadLabelsMeta = {
  pathInputs: [
    [0.1, 0.5],
    [0.9, 0.5],
  ],
  pathRanges: [{ start: 0, count: 2, labelIndex: 0 }],
  pathLabels: [{ text: "Main", key: "9" }],
  labelStyle: null,
  glyphBounds: [
    [0, 12, -2, 8],
    [12, 24, -2, 8],
  ],
  glyphBoundRanges: [{ start: 0, count: 2 }],
  sizes: [[24, 10]],
  anchorRanges: [{ start: 0, count: 1 }],
  anchors: [{ pathIndex: 0, segmentIndex: 0, t: 0.5, anchorOrdinal: 0 }],
};

/** A tile of `labels`, in the parser's order (by the zoom they show from), each a 10 by 6 point box. */
function sourceTile(tile: Tile, labels: readonly Label[], road: RoadLabelsMeta = emptyRoad): LabelSourceTile {
  const placementInputs: TextLabelPlacementInput[] = labels.map((label) => ({
    uv: label.uv,
    roofHeight: 0,
    liftsToRoof: false,
    key: String(label.key),
    sortKey: 0,
    collisionPriority: label.priority ?? 0,
    labelSizePoints: [10, 6],
    minCameraZoom: label.minZoom ?? 0,
    maxCameraZoom: null,
    isLocal: false,
  }));
  const text = { placementInputs, glyphRunStyles: [], poiIconRunStyles: [], routeShieldRunStyles: [] };
  const gpu = { meta: { labels: { text, road, surface: [] } }, labels: { roadGlyphs: { vertexOffset: 0, vertexCount: 12 } } } as unknown as GpuTile;
  return { tile, gpu, textLabels: makeTileTextLabels(text) };
}

function own(resident: LabelSourceTile): PlaceTile<LabelSourceTile> {
  return makePlaceTile(resident, { tile: resident.tile, worldWrap: 0 });
}

/** The render world straight to clip space, w 1: on a map of size 2, tile 0/0 of zoom 1 covers x -1 to 0, y 0 to 1, the screen's upper left quarter. */
const identity = mat4FromColumns([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);

const cameraState: ImmersiveMapCameraState = { centerWorldMercator: [0.25, 0.25], zoom: 14, bearing: 0, pitch: 0 };

function frame(placements: PlaceTile<LabelSourceTile>[], timeSeconds: number, overrides: Partial<LabelFrameInput> = {}): LabelFrameInput {
  return {
    placements,
    renderSurfaceMode: "flat",
    screenSpaceProjectionMode: "flat",
    projectionView: identity,
    cameraEye: [-0.5, 0.5, 1],
    cameraState,
    drawWidth: 1000,
    drawHeight: 1000,
    planningZoom: 14,
    pixelsPerPoint: 1,
    timeSeconds,
    flatRenderState: { pan: [0, 0], renderMapSize: 2 },
    globe: { panX: 0, panY: 0, radius: 1, transition: 1 },
    globeConstants: undefined,
    centerWorldMercator: [0.25, 0.25],
    tileZoomLevel: 1,
    buildingRise: BuildingRiseCoverage.none,
    buildingRiseSignature: 0,
    ...overrides,
  };
}

/** Steps `prepare` through frames at `times`, long enough apart to finish every fade. */
function run(prepare: BaseLabelPrepare, placements: PlaceTile<LabelSourceTile>[], times: number[], overrides: Partial<LabelFrameInput> = {}): void {
  for (const time of times) prepare.update(frame(placements, time, overrides));
}

const tile: Tile = { x: 0, y: 0, z: 1 };

describe("BaseLabelPrepare", () => {
  test("the better ranked of two overlapping labels shows, the other stays dark", () => {
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    const placements = [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1, priority: 5 }, { uv: [0.505, 0.5], key: 2, priority: 0 }, { uv: [0.5, 0.1], key: 3, priority: 9 }]))];
    run(prepare, placements, [0, 1]);
    expect(Array.from(prepare.baseCollisionVisibility)).toEqual([0, 1, 1]);
    expect(Array.from(prepare.baseAlphas)).toEqual([0, 1, 1]);
    const records = prepare.baseCache.frameRecords;
    expect([records[L.floats + L.screenX], records[L.floats + L.screenY]], "uv (0.505, 0.5) is x -0.495, y 0.5").toEqual([252.5, 750]);
    expect(records[L.floats + L.fadeAlpha]).toBe(1);
    expect(records[L.fadeAlpha]).toBe(0);
  });

  test("a label fades in over the fade-in time, from the frame after it is first decided", () => {
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    const placements = [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1 }]))];
    prepare.update(frame(placements, 0));
    expect(prepare.baseAlphas[0]).toBe(0);
    expect(prepare.hasActiveFadeAnimations).toBe(true);
    prepare.update(frame(placements, defaultLabelSettings.base.fadeInSeconds / 2));
    expect(prepare.baseAlphas[0]).toBeCloseTo(0.5, 5);
    run(prepare, placements, [1, 2]);
    expect(prepare.baseAlphas[0]).toBe(1);
    expect(prepare.hasActiveFadeAnimations, "a still camera with every fade done settles").toBe(false);
  });

  test("the overview fade dims every label as the camera leaves the planet's first zoom", () => {
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    const placements = [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1 }]))];
    run(prepare, placements, [0, 1], { planningZoom: 0.5 });
    expect(prepare.baseAlphas[0]).toBe(1);
    expect(prepare.baseCache.frameRecords[L.fadeAlpha]).toBeCloseTo(0.5, 6);
  });

  test("a label below its zoom is not worked on and takes no space", () => {
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    const placements = [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1, priority: 5 }, { uv: [0.5, 0.5], key: 2, priority: 0, minZoom: 16 }]))];
    run(prepare, placements, [0, 1]);
    expect(prepare.spans).toEqual([0, 1]);
    expect(Array.from(prepare.baseAlphas), "the better ranked label waits for zoom 16 and leaves the space to the other").toEqual([1, 0]);

    run(prepare, placements, [2, 3], { planningZoom: 16, cameraState: { ...cameraState, zoom: 16 } });
    expect(Array.from(prepare.baseAlphas), "at its zoom it takes the space").toEqual([0, 1]);
  });

  // The exact tile and the coarser one standing in beside it both bring
  // feature 20, at two places on screen: one copy of it draws, the exact
  // tile's.
  test("the copies of one feature that two tiles bring draw once", () => {
    const exact = sourceTile({ x: 0, y: 0, z: 2 }, [{ uv: [0.5, 0.5], key: 20 }]);
    const standIn = sourceTile(tile, [{ uv: [0.9, 0.9], key: 20 }, { uv: [0.6, 0.9], key: 30 }]);
    const placements = [makePlaceTile(standIn, { tile: { x: 1, y: 1, z: 2 }, worldWrap: 0 }), own(exact)];
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, placements, [0, 1]);
    expect(Array.from(prepare.baseCache.keys)).toEqual([20n, 20n, 30n]);
    expect(Array.from(prepare.baseAlphas)).toEqual([1, 0, 1]);
  });

  test("a tile that stays keeps its fades across a change of the tile set", () => {
    const stays = sourceTile({ x: 1, y: 0, z: 2 }, [{ uv: [0.5, 0.5], key: 1 }]);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(stays)], [0, 1]);
    expect(Array.from(prepare.baseAlphas)).toEqual([1]);

    const arrives = sourceTile({ x: 0, y: 0, z: 2 }, [{ uv: [0.5, 0.5], key: 2 }]);
    prepare.update(frame([own(arrives), own(stays)], 1));
    expect(Array.from(prepare.baseCache.keys), "the set is in winner order: x first").toEqual([2n, 1n]);
    expect(Array.from(prepare.baseAlphas), "the surviving label keeps its fade, the new one starts dark").toEqual([0, 1]);
  });

  // The exact tile replaces its parent at a zoom step: no run survives, but
  // the feature lit in the parent keeps its fade in the child.
  test("a lit label keeps its fade when its tile is swapped for another bringing it", () => {
    const parent = sourceTile(tile, [{ uv: [0.5, 0.5], key: 7 }]);
    const child = sourceTile({ x: 1, y: 1, z: 2 }, [{ uv: [0, 0], key: 7 }]);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(parent)], [0, 1]);
    prepare.update(frame([own(child)], 1));
    expect(Array.from(prepare.baseAlphas)).toEqual([1]);
  });

  // The cache keeps the box in layout points, the frame scales it by the
  // display's pixels per point next to the screen position it pairs with. Two
  // labels the same pixels apart clear each other at a low scale and collide
  // at a higher one, where their boxes cover more pixels.
  test("the collision boxes convert to pixels with the display", () => {
    // Half sizes of 10 and 8 points with the spacing margin: 0.03 of the tile is 15 px apart, clear at 0.5 px a point and not at 1.
    const placements = [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1, priority: 0 }, { uv: [0.53, 0.5], key: 2, priority: 1 }]))];
    const sparse = new BaseLabelPrepare(defaultLabelSettings);
    run(sparse, placements, [0, 1], { pixelsPerPoint: 0.5 });
    expect(Array.from(sparse.baseCollisionVisibility)).toEqual([1, 1]);
    const dense = new BaseLabelPrepare(defaultLabelSettings);
    run(dense, placements, [0, 1], { pixelsPerPoint: 1 });
    expect(Array.from(dense.baseCollisionVisibility)).toEqual([1, 0]);
  });

  // A collision grid in device pixels would let a 3x phone pack 2.25 times as
  // many labels into a physically smaller screen. In points the cell keeps the
  // same perceived size.
  test("the collision grid cell is expressed in points", () => {
    expect(defaultLabelSettings.base.gridCellSizePoints).toBe(16);
    expect(defaultLabelSettings.road.gridCellSizePoints).toBe(16);
  });

  test("a placement that draws no labels offers none", () => {
    const resident = sourceTile(tile, [{ uv: [0.5, 0.5], key: 1 }]);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    prepare.update(frame([makePlaceTile(resident, { tile, worldWrap: 0 }, { rules: { drawsLines: true, drawsLabels: false, raster: undefined } })], 0));
    expect(prepare.baseCache.labelCount).toBe(0);
    expect(prepare.hasRenderableLabels).toBe(false);
  });

  test("a road name shows along its road when nothing covers it", () => {
    const resident = sourceTile(tile, [{ uv: [0.5, 0.1], key: 1 }], straightRoad);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(resident)], [0, 1]);
    expect(Array.from(prepare.roadCollisionVisibility)).toEqual([1]);
    expect(Array.from(prepare.roadAlphas)).toEqual([1]);
    expect(prepare.roadDraws).toHaveLength(1);
    expect(prepare.roadGlyphCount).toBe(2);
    const glyphs = prepare.roadGlyphRecords;
    // The anchor at u 0.5 is x 250 px, y 750 px. The glyphs' centres are 6 and 18 points into the 24 point label.
    expect([glyphs[0], glyphs[1], glyphs[2], glyphs[3]]).toEqual([244, 750, 0, 1]);
    expect([glyphs[4], glyphs[5]], "the glyph's centre and the label's vertical centre").toEqual([6, 3]);
    expect(glyphs[8]).toBe(256);
    expect(Array.from(prepare.baseAlphas), "the base label beside it shows too").toEqual([1]);
  });

  test("a base label outranks a road name it overlaps", () => {
    const resident = sourceTile(tile, [{ uv: [0.5, 0.5], key: 1, priority: 50 }], straightRoad);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(resident)], [0, 1]);
    expect(Array.from(prepare.baseAlphas)).toEqual([1]);
    expect(Array.from(prepare.roadCollisionVisibility)).toEqual([0]);
    expect(prepare.roadDraws, "no road name in sight and none fading").toHaveLength(0);
  });

  test("a road tile too small on screen offers its names nothing", () => {
    const resident = sourceTile(tile, [], straightRoad);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    // Ten zooms coarser than the frame's tiles: its world is squeezed a millionfold.
    run(prepare, [own(resident)], [0, 1], { tileZoomLevel: 11 });
    expect(Array.from(prepare.roadCollisionVisibility)).toEqual([0]);
  });

  test("the globe draws no road names", () => {
    const resident = sourceTile(tile, [], straightRoad);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(resident)], [0, 1], { renderSurfaceMode: "spherical" });
    expect(prepare.roadDraws).toHaveLength(0);
    expect(prepare.roadGlyphCount).toBe(0);
  });

  test("a reset forgets every label", () => {
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1 }], straightRoad))], [0, 1]);
    expect(prepare.hasRenderableLabels).toBe(true);
    prepare.reset();
    expect(prepare.hasRenderableLabels).toBe(false);
    expect(prepare.baseAlphas).toHaveLength(0);
    expect(prepare.hasActiveFadeAnimations).toBe(false);
  });

  test("without the panel's switches a frame collects no boxes and writes no trace", () => {
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    run(prepare, [own(sourceTile(tile, [{ uv: [0.5, 0.1], key: 1 }], straightRoad))], [0, 1]);
    expect(prepare.lastDebugBoxes).toBe(emptyLabelDebugBoxes);
    expect(prepare.traceRecorder).toBeUndefined();
  });

  test("the debug boxes are the labels' collision boxes on screen, y down, by their decision", () => {
    const resident = sourceTile(tile, [{ uv: [0.5, 0.1], key: 1 }, { uv: [0.502, 0.1], key: 2, priority: 9 }], straightRoad);
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    prepare.debugBoxes = { base: true, road: true };
    run(prepare, [own(resident)], [0, 1]);
    const { boxes, roadBoxes } = prepare.lastDebugBoxes;
    // uv (0.5, 0.1) is x 250 px, 950 px up from the bottom, 50 px down from the top: a 10 by 6 point box.
    expect(boxes[0]).toEqual({ minX: 245, minY: 47, maxX: 255, maxY: 53, isVisible: true });
    expect(boxes[1]!.isVisible, "the one that lost the collision is listed, hidden").toBe(false);
    expect(roadBoxes).toHaveLength(2);
    expect(roadBoxes.map((box) => [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2])).toEqual([
      [244, 250],
      [256, 250],
    ]);
    expect(roadBoxes.every((box) => box.isVisible)).toBe(true);

    prepare.debugBoxes = { base: false, road: true };
    run(prepare, [own(resident)], [2]);
    expect(prepare.lastDebugBoxes.boxes, "each toggle on its own").toHaveLength(0);
    expect(prepare.lastDebugBoxes.roadBoxes).toHaveLength(2);
    prepare.debugBoxes = undefined;
    run(prepare, [own(resident)], [3]);
    expect(prepare.lastDebugBoxes).toBe(emptyLabelDebugBoxes);
  });

  test("the road label tiles are the road tiles near enough for their names", () => {
    const resident = sourceTile(tile, [], straightRoad);
    const near = new BaseLabelPrepare(defaultLabelSettings);
    run(near, [own(resident)], [0, 1]);
    expect(near.activeRoadLabelTiles).toEqual([{ tile, worldWrap: 0 }]);
    const far = new BaseLabelPrepare(defaultLabelSettings);
    run(far, [own(resident)], [0, 1], { tileZoomLevel: 11 });
    expect(far.activeRoadLabelTiles).toEqual([]);
  });

  test("a recording base label trace gets one line a frame with the frame's decisions", async () => {
    const recorder = new BaseLabelTraceRecorder(undefined, { now: () => 1_000_000 });
    const prepare = new BaseLabelPrepare(defaultLabelSettings);
    prepare.traceRecorder = recorder;
    const placements = [own(sourceTile(tile, [{ uv: [0.5, 0.5], key: 1, priority: 5 }, { uv: [0.505, 0.5], key: 2 }]))];
    run(prepare, placements, [0]);
    recorder.startRecording();
    run(prepare, placements, [1], { frameIndex: 30 });
    recorder.stopRecording();
    run(prepare, placements, [2]);
    const lines = (await recorder.takeBlob()!.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "base_label_frame",
      frame: 30,
      zoom: 14,
      sourceTileCount: 1,
      labelInputsCount: 2,
      collisionVisibleCount: 1,
      collisionHiddenCount: 1,
      targetVisibleCount: 1,
      fadeVisibleCount: 1,
      labelsIncluded: true,
      hotBuckets: "3/11:2/1/1",
      maxHotBucketCount: 2,
    });
    expect(String(lines[0]!["labels"]).split(";")[1]).toBe("1|2|v=1|d=0|cv=visible|t=1|hz=1|a=1.00|x=252.50|y=750.00|sv=1|p=0|hw=5.00|hh=3.00");
  });
});
