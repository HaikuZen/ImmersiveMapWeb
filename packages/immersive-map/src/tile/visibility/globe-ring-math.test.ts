// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeRingMathTests`: rings of target tiles from the
// look-at tile, the columns closing at the antimeridian and the rows ending
// at the poles.

import { describe, expect, test } from "vitest";
import { GlobeRingMath } from "./globe-ring-math.ts";

const range = (lowerBound: number, upperBound: number) => ({ lowerBound, upperBound });

describe("GlobeRingMath", () => {
  test("the look-at tile is the centre floored", () => {
    expect(GlobeRingMath.lookAtTile({ tileX: 32.7, tileY: 12.2 }, 6)).toEqual({ x: 32, y: 12 });
    expect(GlobeRingMath.lookAtTile({ tileX: 64, tileY: -0.5 }, 6), "clamped into the grid").toEqual({ x: 63, y: 0 });
  });

  test("a target tile's ring is its grid distance", () => {
    const lookAt = { x: 32, y: 32 };
    expect(GlobeRingMath.ringRange({ x: 32, y: 32, z: 6 }, 6, lookAt)).toEqual(range(0, 0));
    expect(GlobeRingMath.ringRange({ x: 33, y: 31, z: 6 }, 6, lookAt)).toEqual(range(1, 1));
    expect(GlobeRingMath.ringRange({ x: 30, y: 37, z: 6 }, 6, lookAt)).toEqual(range(5, 5));
  });

  test("a coarser tile spans its rings", () => {
    const lookAt = { x: 32, y: 32 };
    // z4/8/8 holds columns and rows 32 to 35.
    expect(GlobeRingMath.ringRange({ x: 8, y: 8, z: 4 }, 6, lookAt)).toEqual(range(0, 3));
    // z4/9/8 holds columns 36 to 39.
    expect(GlobeRingMath.ringRange({ x: 9, y: 8, z: 4 }, 6, lookAt)).toEqual(range(4, 7));
    expect(GlobeRingMath.ringRange({ x: 0, y: 0, z: 0 }, 6, lookAt)).toEqual(range(0, 32));
  });

  test("the columns close on themselves", () => {
    const lookAt = { x: 0, y: 32 };
    expect(GlobeRingMath.ringRange({ x: 63, y: 32, z: 6 }, 6, lookAt)).toEqual(range(1, 1));
    expect(GlobeRingMath.ringRange({ x: 60, y: 32, z: 6 }, 6, lookAt)).toEqual(range(4, 4));
    expect(GlobeRingMath.ringRange({ x: 32, y: 32, z: 6 }, 6, lookAt), "the antipode's column is half the world away").toEqual(range(32, 32));
    // z4/15/8 holds columns 60 to 63, just across the seam.
    expect(GlobeRingMath.ringRange({ x: 15, y: 8, z: 4 }, 6, lookAt)).toEqual(range(1, 4));
    // z3/4/4 holds columns 32 to 39: the antipode's column is in it.
    expect(GlobeRingMath.wrappedAxisRange(32, 8, 0, 64)).toEqual(range(25, 32));
    // Columns 24 to 31 lie short of the antipode going up.
    expect(GlobeRingMath.wrappedAxisRange(24, 8, 0, 64)).toEqual(range(24, 31));
  });

  test("the rows end at the poles", () => {
    expect(GlobeRingMath.ringRange({ x: 32, y: 63, z: 6 }, 6, { x: 32, y: 0 })).toEqual(range(63, 63));
    expect(GlobeRingMath.axisRange(0, 4, 0)).toEqual(range(0, 3));
  });

  test("the shallow world is a few rings wide", () => {
    expect(GlobeRingMath.ringRange({ x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0 })).toEqual(range(0, 0));
    expect(GlobeRingMath.ringRange({ x: 3, y: 2, z: 2 }, 2, { x: 0, y: 2 })).toEqual(range(1, 1));
    expect(GlobeRingMath.ringRange({ x: 2, y: 2, z: 2 }, 2, { x: 0, y: 2 })).toEqual(range(2, 2));
  });
});
