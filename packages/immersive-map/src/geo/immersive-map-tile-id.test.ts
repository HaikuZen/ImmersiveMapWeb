// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The Swift `ImmersiveMapTileIDTests`, and the bounds a tile is selectable by.

import { describe, expect, test } from "vitest";
import { ImmersiveMapGeoBounds } from "./immersive-map-geo-bounds.ts";
import { ImmersiveMapTileID, tileNumber } from "./immersive-map-tile-id.ts";

describe("ImmersiveMapTileID", () => {
  test("a tile's numbers are held to the map", () => {
    expect(ImmersiveMapTileID.make(3, 9, -2)).toEqual({ zoom: 3, x: 1, y: 0 });
    expect(ImmersiveMapTileID.make(3, -1, 99)).toEqual({ zoom: 3, x: 7, y: 7 });
    expect(ImmersiveMapTileID.make(40, 0, 0).zoom).toBe(ImmersiveMapTileID.maximumZoom);
    expect(ImmersiveMapTileID.make(-4, 5, 5)).toEqual({ zoom: 0, x: 0, y: 0 });
  });

  test("the tile that holds a coordinate", () => {
    // Red Square.
    expect(ImmersiveMapTileID.containing({ latitude: 55.7539, longitude: 37.6208 }, 15)).toEqual({ zoom: 15, x: 19808, y: 10243 });
    expect(ImmersiveMapTileID.containing({ latitude: 0, longitude: 0 }, 1)).toEqual({ zoom: 1, x: 1, y: 1 });
    // Past the map's edge: the tile of the edge.
    expect(ImmersiveMapTileID.containing({ latitude: 89.9, longitude: 0 }, 4).y).toBe(0);
    expect(ImmersiveMapTileID.containing({ latitude: -89.9, longitude: 0 }, 4).y).toBe(15);
    expect(ImmersiveMapTileID.containing({ latitude: 0, longitude: 180 }, 4).x).toBe(0);
  });

  test("a tile's box and its middle", () => {
    const tile = ImmersiveMapTileID.make(1, 1, 0);
    const bounds = ImmersiveMapTileID.bounds(tile);
    expect(bounds.southWest.longitude).toBeCloseTo(0, 12);
    expect(bounds.northEast.longitude).toBeCloseTo(180, 12);
    expect(bounds.southWest.latitude).toBeCloseTo(0, 12);
    expect(bounds.northEast.latitude).toBeCloseTo(85.0511287798, 8);
    const center = ImmersiveMapTileID.center(tile);
    expect(center.longitude).toBeCloseTo(90, 12);
    // North of the middle of its latitudes: the map stretches toward the pole.
    expect(center.latitude).toBeGreaterThan(42.5);
    expect(ImmersiveMapTileID.containing(center, 1)).toEqual(tile);
  });

  test("the tile above and the four below", () => {
    const tile = ImmersiveMapTileID.make(15, 19807, 10243);
    expect(ImmersiveMapTileID.parent(tile)).toEqual({ zoom: 14, x: 9903, y: 5121 });
    expect(ImmersiveMapTileID.parent(ImmersiveMapTileID.make(0, 0, 0))).toBeNull();
    const children = ImmersiveMapTileID.children(tile);
    expect(children).toEqual([
      { zoom: 16, x: 39614, y: 20486 },
      { zoom: 16, x: 39615, y: 20486 },
      { zoom: 16, x: 39614, y: 20487 },
      { zoom: 16, x: 39615, y: 20487 },
    ]);
    expect(children.every((child) => ImmersiveMapTileID.equals(ImmersiveMapTileID.parent(child)!, tile))).toBe(true);
    expect(ImmersiveMapTileID.children(ImmersiveMapTileID.make(24, 0, 0))).toEqual([]);
  });

  test("a tile's key and its number name it alone", () => {
    const tile = ImmersiveMapTileID.make(15, 19807, 10243);
    expect(ImmersiveMapTileID.key(tile)).toBe("15/19807/10243");
    expect(ImmersiveMapTileID.fromKey("15/19807/10243")).toEqual(tile);
    expect(ImmersiveMapTileID.fromKey("15/19807")).toBeNull();
    expect(ImmersiveMapTileID.fromKey("a/b/c")).toBeNull();
    const deepest = 2 ** 24 - 1;
    expect(Number.isSafeInteger(tileNumber(24, deepest, deepest))).toBe(true);
    expect(tileNumber(24, deepest, deepest)).not.toBe(tileNumber(24, deepest, deepest - 1));
    expect(tileNumber(3, 1, 0)).not.toBe(tileNumber(3, 0, 1));
  });
});

describe("ImmersiveMapGeoBounds", () => {
  const box = (south: number, west: number, north: number, east: number): ImmersiveMapGeoBounds => ImmersiveMapGeoBounds.make({ latitude: south, longitude: west }, { latitude: north, longitude: east });

  test("a box holds its edges", () => {
    const city = box(55, 37, 56, 38);
    expect(ImmersiveMapGeoBounds.contains(city, { latitude: 55.5, longitude: 37.5 })).toBe(true);
    expect(ImmersiveMapGeoBounds.contains(city, { latitude: 56, longitude: 38 })).toBe(true);
    expect(ImmersiveMapGeoBounds.contains(city, { latitude: 56.1, longitude: 37.5 })).toBe(false);
    expect(ImmersiveMapGeoBounds.contains(city, { latitude: 55.5, longitude: 397.5 })).toBe(true);
  });

  test("a box whose east is west of its west spans the antimeridian", () => {
    const pacific = box(-10, 170, 10, -170);
    expect(ImmersiveMapGeoBounds.contains(pacific, { latitude: 0, longitude: 179 })).toBe(true);
    expect(ImmersiveMapGeoBounds.contains(pacific, { latitude: 0, longitude: -175 })).toBe(true);
    expect(ImmersiveMapGeoBounds.contains(pacific, { latitude: 0, longitude: 0 })).toBe(false);
    expect(ImmersiveMapGeoBounds.intersects(pacific, box(-5, -180, 5, -175))).toBe(true);
    expect(ImmersiveMapGeoBounds.intersects(pacific, box(-5, -160, 5, -150))).toBe(false);
    // The whole turn, however it is written.
    expect(ImmersiveMapGeoBounds.contains(box(-10, -180, 10, 180), { latitude: 0, longitude: 77 })).toBe(true);
  });

  test("two boxes that share an edge intersect and do not overlap", () => {
    const left = box(0, 0, 10, 10);
    const right = box(0, 10, 10, 20);
    expect(ImmersiveMapGeoBounds.intersects(left, right)).toBe(true);
    expect(ImmersiveMapGeoBounds.overlaps(left, right)).toBe(false);
    expect(ImmersiveMapGeoBounds.overlaps(left, box(5, 5, 15, 15))).toBe(true);
    // A tile beside a box drawn along its edge.
    const tile = ImmersiveMapTileID.make(2, 2, 1);
    const beside = ImmersiveMapTileID.bounds(ImmersiveMapTileID.make(2, 3, 1));
    expect(ImmersiveMapGeoBounds.overlaps(ImmersiveMapTileID.bounds(tile), beside)).toBe(false);
  });
});
