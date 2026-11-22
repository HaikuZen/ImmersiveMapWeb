// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Where a ground tile lies in its terrain (the Swift
// `GroundReliefTests.testATileLiesInItsAncestorsTerrainByItsAddress`), a
// narrowed relief (`GroundReliefShadowCasterTests.testANarrowedReliefReadsTheSameHeights`,
// the terrain tile over plain objects in place of a Metal texture), and,
// with no Swift test of their own, the buildings' lifts and the
// surroundings' reading, which follow their doc comments.

import { afterEach, describe, expect, test } from "vitest";
import { defaultTerrainSurroundingsSettings, groundReliefSettings } from "../../../configuration/tile-settings.ts";
import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../../math/vec.ts";
import type { Tile } from "../../tile.ts";
import { GroundReliefTile } from "../store/ground-relief-tile.ts";
import { halves } from "../store/half-float.ts";
import { type FakeAnswer, flatAnswer, loadUntil, makeTestRelief, type TestRelief } from "../testing/ground-relief-fakes.ts";
import { type BuildingAnchorTile, BuildingReliefLifts } from "./building-relief-lifts.ts";
import { GroundRelief } from "./ground-relief.ts";
import { GroundReliefSurroundings } from "./ground-relief-surroundings.ts";
import { terrainSurroundingsEqual } from "./terrain-surroundings.ts";

function expectClose(actual: number | undefined, expected: number, accuracy: number, message?: string): void {
  expect(actual, message).toBeDefined();
  expect(Math.abs(actual! - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

const made: TestRelief[] = [];
function relief(answer: (tile: Tile) => FakeAnswer, minimumSourceZoom = 10): TestRelief {
  const value = makeTestRelief(groundReliefSettings({ isEnabled: true, minimumSourceZoom }), answer);
  made.push(value);
  return value;
}
afterEach(() => {
  for (const value of made.splice(0)) value.store.destroy();
});

describe("GroundRelief", () => {
  test("a tile lies in its ancestor's terrain by its address", () => {
    expect(GroundRelief.placement({ x: 9647, y: 12320, z: 15 }, { x: 9647, y: 12320, z: 15 })).toEqual({ originX: 0, originY: 0, scale: 1 });
    expect(GroundRelief.placement({ x: 9647, y: 12321, z: 15 }, { x: 1205, y: 1540, z: 12 })).toEqual({ originX: 0.875, originY: 0.125, scale: 0.125 });
  });

  test("a narrowed relief reads the same heights", () => {
    const size = 4;
    const metres = Array.from({ length: size * size }, (_, index) => index * 10);
    const terrain = new GroundReliefTile({ id: 1, byteLength: size * size * 2 }, size, halves(metres), { lowerBound: 0, upperBound: 150 });
    const whole = new GroundRelief(terrain, 0, 0, 1, 1);
    const narrowed = whole.narrowed({ x: 1, y: 1, z: 2 }, { x: 0, y: 0, z: 1 });
    for (const [u, v] of [
      [0, 0],
      [0.5, 0.25],
      [1, 1],
    ] as const) {
      expectClose(narrowed.metresAtTileUV(u, v), whole.metresAtTileUV(0.5 + u * 0.5, 0.5 + v * 0.5), 1e-3);
    }
    expect(narrowed.terrain, "the same terrain tile").toBe(terrain);
  });

  test("a point is drawn at its height over the datum, times the strength", () => {
    const terrain = new GroundReliefTile({ id: 1, byteLength: 8 }, 2, halves([100, 100, 100, 100]), { lowerBound: 100, upperBound: 100 });
    const drawn = new GroundRelief(terrain, 0, 0, 1, 2);
    expect(drawn.drawnMetresAtTileUV(0.5, 0.5, 40)).toBe(120);
    expect(drawn.metresAtTileUV(-3, 7), "the uv clamped to the tile").toBe(100);
  });
});

describe("BuildingReliefLifts", () => {
  const tile: Tile = { x: 600, y: 400, z: 10 };
  const anchored = (anchors: number[]): BuildingAnchorTile => ({ tile, buildingAnchors: new Float32Array(anchors) });

  test("each building stands at the terrain's metres under its anchor, made once per terrain", async () => {
    // A slope rising east: 0 m on the west column, 400 m on the east.
    const ground = relief(() => ({ metres: [0, 400, 0, 400] }));
    expect(await loadUntil(ground, [tile], () => ground.store.isResident(tile))).toBe(true);
    const lifts = new BuildingReliefLifts<BuildingAnchorTile>();
    // Render space, y up: the west quarter and the east quarter.
    const resident = anchored([1024, 2048, 3072, 2048]);
    const placement = { resident, displacement: tile };
    const first = lifts.update([placement], ground.state.frame)[0]!;
    expect([...first.metres]).toEqual([0, 400]);
    expect(first.terrainId).toBe(ground.store.terrain(tile)!.terrain.id);
    expect(lifts.update([placement], ground.state.frame)[0], "kept while the tile draws with the same terrain").toBe(first);
    ground.store.terrain(tile)!.terrain.writeTexels(new Uint16Array([0]), 1, 0, 1, 1);
    const welded = lifts.update([placement], ground.state.frame)[0]!;
    expect(welded, "a weld places them again").not.toBe(first);
    expect(welded.revision).toBe(1);
  });

  test("no buildings, no terrain or no relief lift nothing", async () => {
    const ground = relief(() => flatAnswer(50));
    expect(await loadUntil(ground, [tile], () => ground.store.isResident(tile))).toBe(true);
    const lifts = new BuildingReliefLifts<BuildingAnchorTile>();
    const resident = anchored([2048, 2048]);
    expect(lifts.update([{ resident: anchored([]), displacement: tile }], ground.state.frame), "no buildings").toEqual([undefined]);
    expect(lifts.update([{ resident, displacement: undefined }], ground.state.frame), "on the plane").toEqual([undefined]);
    expect(lifts.update([{ resident, displacement: { x: 0, y: 0, z: 3 } }], ground.state.frame), "terrain not in").toEqual([undefined]);
    const kept = lifts.update([{ resident, displacement: tile }], ground.state.frame)[0];
    expect(kept?.metres[0]).toBe(50);
    expect(lifts.update([{ resident, displacement: tile }], undefined), "no relief").toEqual([undefined]);
    expect(lifts.update([{ resident, displacement: tile }], ground.state.frame)[0], "the cache was let go").not.toBe(kept);
    ground.state.setActive(false);
    expect(lifts.update([{ resident, displacement: tile }], ground.state.frame), "off the terrain").toEqual([undefined]);
  });
});

describe("GroundReliefSurroundings", () => {
  const settings = defaultTerrainSurroundingsSettings;

  test("the span lies between the thresholds, and the kind holds between them", () => {
    expect(GroundReliefSurroundings.mountainousness(150, settings)).toBe(0);
    expect(GroundReliefSurroundings.mountainousness(375, settings)).toBe(0.5);
    expect(GroundReliefSurroundings.mountainousness(900, settings)).toBe(1);
    expect(GroundReliefSurroundings.mountainousness(300, { ...settings, plainBelowMetres: 400, mountainsAboveMetres: 300 }), "crossed: a step").toBe(1);
    expect(GroundReliefSurroundings.kind(undefined, 700, settings)).toBe("mountains");
    expect(GroundReliefSurroundings.kind("mountains", 300, settings), "held between the thresholds").toBe("mountains");
    expect(GroundReliefSurroundings.kind("mountains", 100, settings)).toBe("plain");
    expect(GroundReliefSurroundings.kind("plain", 500, settings), "held between the thresholds").toBe("plain");
    expect(GroundReliefSurroundings.kind(undefined, 400, settings), "a first reading by the nearer threshold").toBe("mountains");
    expect(GroundReliefSurroundings.kind(undefined, 300, settings)).toBe("plain");
    expect(GroundReliefSurroundings.smoothingShare(0.5, 0.5), "half the way a half life").toBe(0.5);
    expect(GroundReliefSurroundings.smoothingShare(0.1, 0), "no smoothing").toBe(1);
    expect(GroundReliefSurroundings.spanMetres([0.5, 0.5], 0.01, () => undefined), "no terrain, no span").toBeUndefined();
    expect(GroundReliefSurroundings.spanMetres([0.5, 0.5], 0.01, (point) => point[0] * 1000)).toBeCloseTo(20, 6);
  });

  test("the country around the camera is read off the camera's map", async () => {
    // A slope rising east, steep enough for mountains.
    const tile: Tile = { x: 512, y: 340, z: 10 };
    const ground = relief(() => ({ metres: [0, 5000, 0, 5000] }));
    const centre: Vec2 = [(tile.x + 0.5) / 1024, (tile.y + 0.5) / 1024];
    const surroundings = new GroundReliefSurroundings();
    expect(surroundings.update(ground.state.frame, centre, settings, 1 / 60), "the terrain under the point still on its way").toBeNull();
    expect(await loadUntil(ground, [tile], () => ground.store.isResident(tile))).toBe(true);
    ground.state.setDatum(1234.4);
    const read = surroundings.update(ground.state.frame, centre, settings, 1 / 60)!;
    // Bilinear across the tile's middle: 5000 m over half the tile, the outer ring reaching the radius east and west.
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(centre[1]);
    const radiusUV = (settings.sampleRadiusMetres * 1024) / (ImmersiveMapProjection.earthCircumferenceMeters * Math.cos(latitude));
    expectClose(read.heightSpanMetres, 20_000 * radiusUV, 1);
    expect(read.kind).toBe("mountains");
    expect(read.mountainousness).toBe(1);
    expect(read.groundMetres, "the datum, in whole metres").toBe(1234);
    expect(terrainSurroundingsEqual(read, surroundings.update(ground.state.frame, centre, settings, 1 / 60)), "a frame at rest reads the same").toBe(true);
    ground.state.setActive(false);
    expect(surroundings.update(ground.state.frame, centre, settings, 1 / 60), "off the terrain").toBeNull();
    expect(terrainSurroundingsEqual(null, null)).toBe(true);
    expect(terrainSurroundingsEqual(read, null)).toBe(false);
  });
});
