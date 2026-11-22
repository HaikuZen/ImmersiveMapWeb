// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `LabelPerspectiveScaleTests` (a point label's shrink
// for its distance rides to the shaders in its frame record, full size when
// nobody scales it) and the projection side of `BuildingRoofLabelTests` (the
// flat projection lifts a roof label by the rise of the buildings drawn
// under it, wherever its tile came from).

import { describe, expect, test } from "vitest";
import { defaultLabelBaseSettings } from "../../configuration/label-settings.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import { mat4FromColumns, type Mat4 } from "../../math/matrix.ts";
import { BuildingRiseCoverage } from "../../tile/placement/building-rise-coverage.ts";
import { makePlaceTile } from "../../tile/placement/place-tile.ts";
import { quartersAll } from "../../tile/tile-quarters.ts";
import type { GpuTile } from "../../tile/store/tile-gpu.ts";
import type { TextLabelPlacementInput } from "../../tile/store/prepared-labels.ts";
import { BaseLabelCache, LabelFrameRecordLayout as L, type LabelSourceTile } from "./base-label-cache.ts";
import { buildBaseLabelSourceEntries } from "./base-label-source-entry.ts";
import { projectFlatLabels, projectGlobeLabels, type LabelProjectionOutputs } from "./tile-point-screen-projector.ts";
import { makeTileTextLabels } from "./tile-text-labels.ts";

interface Label {
  readonly uv: readonly [number, number];
  readonly roofHeight?: number;
  readonly liftsToRoof?: boolean;
}

function cacheOf(x: number, y: number, z: number, labels: readonly Label[]): BaseLabelCache {
  const placementInputs: TextLabelPlacementInput[] = labels.map((label, index) => ({
    uv: label.uv,
    roofHeight: label.roofHeight ?? 0,
    liftsToRoof: label.liftsToRoof ?? false,
    key: String(index + 1),
    sortKey: 0,
    collisionPriority: 0,
    labelSizePoints: [10, 6],
    minCameraZoom: 0,
    maxCameraZoom: null,
    isLocal: false,
  }));
  const meta = { placementInputs, glyphRunStyles: [], poiIconRunStyles: [], routeShieldRunStyles: [] };
  const tile: LabelSourceTile = { tile: { x, y, z }, gpu: { meta: { labels: meta } } as unknown as GpuTile, textLabels: makeTileTextLabels(meta) };
  const cache = new BaseLabelCache();
  cache.repack(buildBaseLabelSourceEntries([makePlaceTile(tile, { tile: { x, y, z }, worldWrap: 0 })]));
  return cache;
}

function outputs(count: number): LabelProjectionOutputs {
  return { horizonVisible: new Uint8Array(count), perspectiveScales: new Float32Array(count), anchors: new Float32Array(count * 3) };
}

/**
 * A tilted camera's projection-view, column-major: x and y in render units
 * to clip units one to one per hundred, the depth w growing with y (the
 * north is farther) and shrinking as a point rises, 10 at the origin, the
 * point the camera looks at.
 */
const tilted: Mat4 = mat4FromColumns([0.01, 0, 0, 0], [0, 0.01, 0, 0.01], [0, 0, 0, -0.001], [0, 0, 0, 10]);

/** The slot of the tile: its origin at (-500, -500), 1000 render units a side. */
const slotOrigins = Float64Array.from([-500, -500, 1000]);

function flatFrame(buildingRise = BuildingRiseCoverage.none, maximumDistanceScale = 1.5) {
  return { projectionView: tilted, eye: [0, -2000, 1000] as [number, number, number], viewportWidth: 200, viewportHeight: 100, minimumPerspectiveScale: 0.75, maximumDistanceScale, slotOrigins, buildingRise };
}

describe("label perspective scale", () => {
  test("the scale rides in the frame record after the screen point and before the fade", () => {
    expect(L.floats).toBe(8);
    expect(L.bytes).toBe(32);
    expect([L.screenX, L.screenY, L.visible, L.perspectiveScale, L.fadeAlpha, L.sizeX, L.sizeY]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  // A label nobody scales is its full size: a base label before its first
  // projection.
  test("an unscaled label is full size", () => {
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0.5] }]);
    expect(cache.frameRecords[L.perspectiveScale]).toBe(1);
  });

  test("the default shrinks to three quarters", () => {
    expect(defaultLabelBaseSettings.perspectiveMinimumScale).toBe(0.75);
  });

  test("a label shrinks with its depth past the focus, down to the minimum, never grows", () => {
    // y = -500 + (1 - v) * 1000: v 0.5 is the origin, v 0.3 is y 200 (w 12), v 0 is y 500 (w 15), v 1 is y -500 (w 5).
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0.5] }, { uv: [0.5, 0.3] }, { uv: [0.5, 0] }, { uv: [0.5, 1] }]);
    const out = outputs(4);
    projectFlatLabels(cache, flatFrame(), [0, 4], out);
    expect(out.perspectiveScales[0]).toBe(1);
    expect(out.perspectiveScales[1]).toBeCloseTo(10 / 12, 6);
    expect(out.perspectiveScales[2]).toBe(0.75);
    expect(out.perspectiveScales[3], "nearer than the focus stays full size").toBe(1);
  });

  test("no minimum below one keeps every label full size", () => {
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0] }]);
    const out = outputs(1);
    projectFlatLabels(cache, { ...flatFrame(), minimumPerspectiveScale: 1 }, [0, 1], out);
    expect(out.perspectiveScales[0]).toBe(1);
  });
});

describe("projectFlatLabels", () => {
  test("an anchor lands on screen in device pixels, origin bottom left", () => {
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0.5] }, { uv: [0.75, 0.5] }]);
    const out = outputs(2);
    projectFlatLabels(cache, flatFrame(), [0, 2], out);
    const records = cache.frameRecords;
    expect([records[L.screenX], records[L.screenY], records[L.visible]], "the origin is the viewport's centre").toEqual([100, 50, 1]);
    // x 250 at w 10: clip x 0.25.
    expect(records[L.floats + L.screenX]).toBeCloseTo(125, 4);
    expect(Array.from(out.anchors.subarray(3, 6))).toEqual([250, 0, 0]);
  });

  test("a label past the reach is out of view, one behind the camera is not drawable", () => {
    // v 0 is w 15, at the reach of 1.5 times the focus depth. y = -1500 lies behind the camera.
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0] }, { uv: [0.5, 0.5] }]);
    const out = outputs(2);
    projectFlatLabels(cache, flatFrame(BuildingRiseCoverage.none, 1.4), [0, 2], out);
    expect(Array.from(out.horizonVisible)).toEqual([0, 1]);
    expect(cache.frameRecords[L.visible], "out of reach yet drawable").toBe(1);

    const behind = cacheOf(0, 0, 1, [{ uv: [0.5, 0.5] }]);
    const far = outputs(1);
    projectFlatLabels(behind, { ...flatFrame(), slotOrigins: Float64Array.from([-500, -2500, 1000]) }, [0, 1], far);
    expect(behind.frameRecords[L.visible]).toBe(0);
    expect(far.horizonVisible[0]).toBe(0);
  });

  test("a label of a tile slot the frame does not hold is hidden", () => {
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0.5] }]);
    const out = outputs(1);
    out.anchors.fill(7);
    projectFlatLabels(cache, { ...flatFrame(), slotOrigins: new Float64Array(0) }, [0, 1], out);
    expect(cache.frameRecords[L.visible]).toBe(0);
    expect(out.horizonVisible[0]).toBe(0);
    expect(Array.from(out.anchors)).toEqual([0, 0, 0]);
  });

  test("a roof label rises with the buildings drawn under it", () => {
    // The roof is in the tile's 4096 units: 2048 is half the slot's 1000.
    const labels: Label[] = [{ uv: [0.25, 0.25], roofHeight: 2048, liftsToRoof: true }, { uv: [0.75, 0.75], roofHeight: 2048, liftsToRoof: true }, { uv: [0.5, 0.5], roofHeight: 2048, liftsToRoof: false }];
    const cache = cacheOf(0, 0, 1, labels);
    const rise = new BuildingRiseCoverage();
    // The tile draws its north-west quarter half risen.
    rise.add({ x: 0, y: 0, z: 1 }, 0b0001, 0.5);
    const out = outputs(3);
    projectFlatLabels(cache, flatFrame(rise), [0, 3], out);
    expect(out.anchors[2], "half the roof of 500 units").toBe(250);
    expect(out.anchors[5], "no buildings draw in that quarter").toBe(0);
    expect(out.anchors[8], "a label that does not lift stays on the ground").toBe(0);
  });

  test("a roof label of a coarser tile rises with the finer tile drawing its buildings", () => {
    const cache = cacheOf(0, 0, 1, [{ uv: [0.25, 0.25], roofHeight: 4096, liftsToRoof: true }]);
    const rise = new BuildingRiseCoverage();
    rise.add({ x: 0, y: 0, z: 2 }, quartersAll, 1);
    const out = outputs(1);
    projectFlatLabels(cache, flatFrame(rise), [0, 1], out);
    expect(out.anchors[2]).toBe(1000);
  });

  test("only the labels of the spans are projected", () => {
    const cache = cacheOf(0, 0, 1, [{ uv: [0.5, 0.5] }, { uv: [0.5, 0.5] }]);
    const out = outputs(2);
    projectFlatLabels(cache, flatFrame(), [1, 2], out);
    expect(Array.from(out.horizonVisible)).toEqual([0, 1]);
    expect(cache.frameRecords[L.visible]).toBe(0);
  });
});

describe("projectGlobeLabels", () => {
  // The unit sphere centred one radius below the origin, the camera three
  // units up the z axis looking down it.
  const sphereWorld = mat4FromColumns([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, -1, 1]);
  const view = mat4FromColumns([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, -1], [0, 0, 0, 3]);
  const frame = {
    projectionView: view,
    eye: [0, 0, 3] as [number, number, number],
    viewportWidth: 100,
    viewportHeight: 100,
    minimumPerspectiveScale: 0.75,
    maximumDistanceScale: Infinity,
    globe: { transition: 0, radius: 1, panX: 0 } as unknown as GlobeUniform,
    sphereWorld,
    mapSize: 2,
    panMercatorY: 0,
  };

  test("a label facing the camera shows, one on the far side is behind the horizon", () => {
    // Tile 0/0/0: uv (0.5, 0.5) is the point at latitude 0, longitude 0, uv (0, 0.5) the antimeridian.
    const cache = cacheOf(0, 0, 0, [{ uv: [0.5, 0.5] }, { uv: [0, 0.5] }]);
    const out = outputs(2);
    projectGlobeLabels(cache, frame, [0, 2], out);
    expect(Array.from(out.anchors.subarray(0, 3)).map((value) => Math.abs(value) < 1e-6)).toEqual([true, true, true]);
    expect(cache.frameRecords[L.screenX]).toBeCloseTo(50, 4);
    expect(cache.frameRecords[L.screenY]).toBeCloseTo(50, 4);
    expect(out.anchors[5]).toBeCloseTo(-2, 6);
    expect(Array.from(out.horizonVisible)).toEqual([1, 0]);
    expect(out.perspectiveScales[1], "deeper than the focus shrinks").toBe(0.75);
  });
});
