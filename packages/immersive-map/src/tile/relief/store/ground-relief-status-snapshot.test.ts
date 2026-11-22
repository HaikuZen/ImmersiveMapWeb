// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GroundReliefTests.testTheReliefCardsTellEachTilesState`:
// the relief tab's lines. The cards themselves are the Swift debug overlay's
// (`DebugOverlayTileCard`), which the web panel does not draw. Also the half
// floats the heights are kept as read back (`testHalfFloatsReadBack`), the
// TypeScript side's own conversion beside crates/ground-relief's.

import { describe, expect, test } from "vitest";
import { GroundReliefStatusSnapshot, type GroundReliefStatusFields } from "./ground-relief-status-snapshot.ts";
import { floatToHalfBits, halfBitsToFloat, halves } from "./half-float.ts";

const fields: GroundReliefStatusFields = {
  tiles: [
    { tile: { x: 1, y: 2, z: 12 }, state: "resident", priority: 0, bytes: 1_048_576, heightRange: { lowerBound: 100, upperBound: 2300 }, seconds: 0, attempts: 0 },
    { tile: { x: 2, y: 2, z: 12 }, state: "loading", priority: 1, bytes: 0, heightRange: undefined, seconds: 3, attempts: 0 },
    { tile: { x: 3, y: 2, z: 12 }, state: "failed", priority: 2, bytes: 0, heightRange: undefined, seconds: 8, attempts: 2 },
    { tile: { x: 4, y: 2, z: 11 }, state: "resident", priority: undefined, bytes: 1_048_576, heightRange: { lowerBound: 0, upperBound: 10 }, seconds: 0, attempts: 0 },
  ],
  isActive: true,
  standingShare: 1,
  datumMetres: 0,
  cameraTerrainZoom: 12,
  terrainByRing: "z12→z12",
  wantedCount: 3,
  wantedResidentCount: 1,
  residentCount: 2,
  residentBytes: 2_097_152,
  releasedCount: 1,
  releasedBytes: 1_048_576,
  releasedCacheBytes: 50 * 2 ** 20,
  occlusionComputedCount: 2,
  occlusionMillisecondsLast: 3.25,
  loadingCount: 1,
  maximumConcurrentLoads: 4,
  failedCount: 1,
  missingCount: 0,
};

describe("GroundReliefStatusSnapshot", () => {
  test("the relief tab's lines tell the store's state", () => {
    const snapshot = new GroundReliefStatusSnapshot(fields);
    expect(snapshot.stateLines).toEqual(["relief: on the terrain", "standing 1.00", "datum 0 m"]);
    expect(snapshot.loadingLines).toEqual(["wanted 3", "wanted and in 1", "loading 1 of 4", "failed 1", "missing 0"]);
    expect(snapshot.memoryLines.length).toBe(4);
    expect(snapshot.memoryLines[0]).toBe("in memory 2 tiles, 2.0 MB");
    expect(snapshot.memoryLines[1]).toBe("released 1 tiles, 1.0 of 50.0 MB");
    expect(snapshot.memoryLines.slice(2)).toEqual(["camera map z12", "terrain by ring z12→z12"]);
    expect(snapshot.occlusionLines, "printed as the Swift %.1f prints: a tie to the even digit").toEqual(["computed 2 of 2 tiles", "last tile 3.2 ms"]);
    expect(snapshot.surroundingsLines).toEqual(["around: waiting for terrain"]);
    expect(snapshot.lines.length).toBe(13);
  });

  test("off the terrain and with the surroundings read", () => {
    const off = new GroundReliefStatusSnapshot({ ...fields, isActive: false, terrainByRing: "", datumMetres: 1608.5, standingShare: 0.125 });
    expect(off.stateLines).toEqual(["relief: off the terrain", "standing 0.12", "datum 1608 m"]);
    expect(off.memoryLines[3]).toBe("terrain by ring none");
    expect(off.surroundingsLines).toEqual(["around: off the terrain"]);
    const read = new GroundReliefStatusSnapshot(fields, { kind: "mountains", mountainousness: 0.875, heightSpanMetres: 1200, groundMetres: 1608.4 });
    expect(read.surroundingsLines).toEqual(["around: mountains", "span 1200 m", "mountainousness 0.88", "ground 1608 m"]);
    expect(new GroundReliefStatusSnapshot({ ...fields, occlusionMillisecondsLast: 3.35 }).occlusionLines[1], "no tie: the nearest").toBe("last tile 3.4 ms");
  });
});

describe("half floats", () => {
  test("half floats read back", () => {
    // 1.0, -2.0 and 1000.0 as half floats.
    expect([0x3c00, 0xc000, 0x63d0].map(halfBitsToFloat)).toEqual([1, -2, 1000]);
    expect([...halves([1, -2, 1000])]).toEqual([0x3c00, 0xc000, 0x63d0]);
  });

  test("a float rounds to the nearest half, ties to even, past the largest to infinity", () => {
    // 2049 lies halfway between 2048 and 2050: the even mantissa, 2048.
    expect(halfBitsToFloat(floatToHalfBits(2049))).toBe(2048);
    expect(halfBitsToFloat(floatToHalfBits(2051))).toBe(2052);
    expect(halfBitsToFloat(floatToHalfBits(1000.5))).toBe(1000.5);
    expect(halfBitsToFloat(floatToHalfBits(70_000))).toBe(Number.POSITIVE_INFINITY);
    expect(halfBitsToFloat(floatToHalfBits(-5.960464477539063e-8)), "the smallest subnormal").toBe(-5.960464477539063e-8);
    expect(Number.isNaN(halfBitsToFloat(floatToHalfBits(Number.NaN)))).toBe(true);
  });
});
