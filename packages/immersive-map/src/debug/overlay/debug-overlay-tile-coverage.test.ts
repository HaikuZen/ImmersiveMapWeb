// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayTileCoverageTests`: the debug panel's
// coverage map, the frame's placements from above in normalized Mercator,
// and the relief tab's map built on it.

import { describe, expect, test } from "vitest";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { makePlaceTile } from "../../tile/placement/place-tile.ts";
import { DebugOverlayReliefCoverage, type DebugOverlayReliefCoverageSquare } from "./debug-overlay-relief-coverage.ts";
import {
  DebugOverlayTileCoverage,
  DebugOverlayTileCoverageLayout,
  type DebugOverlayTileCoveragePlacement,
  DebugOverlayTileCoveragePlacement as Placement,
} from "./debug-overlay-tile-coverage.ts";

function placement(slot: [number, number, number], source: [number, number, number], worldWrap = 0): DebugOverlayTileCoveragePlacement {
  return { slot: { x: slot[0], y: slot[1], z: slot[2] }, source: { x: source[0], y: source[1], z: source[2] }, worldWrap };
}

describe("DebugOverlayTileCoverage", () => {
  test("a slot is its square of Mercator", () => {
    const standIn = placement([1, 2, 2], [0, 1, 1]);
    expect(Placement.square(standIn)).toEqual({ x: 0.25, y: 0.5, width: 0.25, height: 0.25 });
    expect(Placement.isStandIn(standIn)).toBe(true);
    const wrapped = placement([0, 0, 1], [0, 0, 1], 1);
    // A copy of the world one unit east.
    expect(Placement.square(wrapped)).toEqual({ x: 1, y: 0, width: 0.5, height: 0.5 });
    expect(Placement.isStandIn(wrapped)).toBe(false);
  });

  test("the flat world maps back onto Mercator", () => {
    // The inverse of the tile origin: zoom 0's tile covers the world.
    const flat = { pan: [0.2, -0.4] as const, renderMapSize: 10 };
    const origin = ImmersiveMapProjection.flatTileOriginAndSize(0, 0, 0, 0, flat.pan, flat.renderMapSize);
    const southWest = DebugOverlayTileCoverage.mercator([origin[0], origin[1]], flat);
    expect(southWest[0]).toBeCloseTo(0, 9);
    // The flat world is y up, Mercator y south.
    expect(southWest[1]).toBeCloseTo(1, 9);
    const northEast = DebugOverlayTileCoverage.mercator([origin[0] + origin[2], origin[1] + origin[2]], flat);
    expect(northEast[0]).toBeCloseTo(1, 9);
    expect(northEast[1]).toBeCloseTo(0, 9);
    // A zoom 3 tile lands on its own square: its north-west corner.
    const tile = ImmersiveMapProjection.flatTileOriginAndSize(5, 2, 3, 0, flat.pan, flat.renderMapSize);
    const corner = DebugOverlayTileCoverage.mercator([tile[0], tile[1] + tile[2]], flat);
    expect(corner[0]).toBeCloseTo(5 / 8, 6);
    expect(corner[1]).toBeCloseTo(2 / 8, 6);
  });

  test("the window is square round the slots and not the footprint", () => {
    const coverage: DebugOverlayTileCoverage = {
      placements: [placement([2, 1, 2], [2, 1, 2]), placement([3, 1, 2], [3, 1, 2])],
      // A camera on the horizon: the footprint reaches far past the tiles,
      // and must not shrink them into a corner.
      footprint: [
        [0.5, 0.25],
        [9.0, 0.25],
        [0.75, 9.0],
      ],
      center: [0.6, 0.3],
      eye: undefined,
    };
    const window = DebugOverlayTileCoverageLayout.window(coverage);
    // Square, so the north stays up and nothing is stretched.
    expect(window.width).toBe(window.height);
    expect(window.x + window.width / 2).toBeCloseTo(0.75, 9);
    expect(window.y + window.height / 2).toBeCloseTo(0.375, 9);
    // The slots' bounds plus the margin.
    expect(window.width).toBeCloseTo(0.5 * 1.12, 9);

    expect(DebugOverlayTileCoverageLayout.point([window.x, window.y], window, 280)).toEqual([0, 0]);
    const rect = DebugOverlayTileCoverageLayout.rect(Placement.square(coverage.placements[0]!), window, 280);
    expect(rect.width).toBeCloseTo((280 * 0.25) / window.width, 6);
  });

  test("an empty frame shows the world round the centre", () => {
    const coverage: DebugOverlayTileCoverage = { placements: [], footprint: [], center: [0.5, 0.5], eye: undefined };
    expect(DebugOverlayTileCoverageLayout.window(coverage)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  // The horizon backdrop, the world tile under everything, is left off the
  // map: its square is the whole world, and a window round it shrank the
  // frame's tiles to a few pixels.
  test("the horizon backdrop is left off the map", () => {
    const world = { x: 0, y: 0, z: 0 };
    const city = { x: 2134, y: 1456, z: 12 };
    const placements = DebugOverlayTileCoverage.placements([
      makePlaceTile({ tile: world }, { tile: world, worldWrap: 0 }, { isHorizonBackdrop: true }),
      makePlaceTile({ tile: city }, { tile: city, worldWrap: 0 }),
    ]);
    expect(placements.map((entry) => entry.slot)).toEqual([city]);
    const coverage: DebugOverlayTileCoverage = { placements, footprint: [], center: [0.52, 0.36], eye: undefined };
    // A window round the frame's tile, not the world.
    expect(DebugOverlayTileCoverageLayout.window(coverage).width).toBeLessThan(0.01);
  });

  test("the coarse slots draw first", () => {
    const fine = placement([4, 4, 3], [4, 4, 3]);
    const coarse = placement([1, 1, 1], [1, 1, 1]);
    expect(DebugOverlayTileCoverageLayout.drawingOrder([fine, coarse])).toEqual([coarse, fine]);
  });
});

describe("DebugOverlayReliefCoverage", () => {
  const wanted: DebugOverlayReliefCoverageSquare = { tile: { x: 4, y: 2, z: 3 }, state: "resident", isWanted: true };
  const kept: DebugOverlayReliefCoverageSquare = { tile: { x: 0, y: 0, z: 1 }, state: "resident", isWanted: false };

  test("the window frames the wanted tiles and the centre, not the kept ones", () => {
    const coverage: DebugOverlayReliefCoverage = { squares: [wanted, kept], footprint: [], center: [0.5625, 0.3125], eye: undefined };
    const window = DebugOverlayReliefCoverage.window(coverage);
    expect(window.width).toBeCloseTo(0.125 * 1.12, 9);
    expect(window.x + window.width / 2).toBeCloseTo(0.5625, 9);
  });

  test("the kept squares draw under the wanted ones", () => {
    const coverage: DebugOverlayReliefCoverage = { squares: [wanted, kept], footprint: [], center: [0.5, 0.5], eye: undefined };
    expect(DebugOverlayReliefCoverage.drawingOrder(coverage)).toEqual([kept, wanted]);
  });
});
