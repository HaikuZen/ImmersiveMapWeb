// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";
import { lonLatToWorld, worldToLonLat } from "./mercator.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/** Swift `SceneModelMetersScaleTests`: the meter scale of the flat render world. */
describe("ImmersiveMapProjection meter scale", () => {
  test("units per meter scale linearly with the render map size", () => {
    const base = ImmersiveMapProjection.worldUnitsPerMeter(0.5, 1000);
    const doubled = ImmersiveMapProjection.worldUnitsPerMeter(0.5, 2000);
    expectClose(doubled / base, 2, 1e-12);
  });

  test("units per meter follow the Mercator latitude inflation", () => {
    const equator = ImmersiveMapProjection.worldUnitsPerMeter(0, 1000);
    const sixty = ImmersiveMapProjection.worldUnitsPerMeter(Math.PI / 3, 1000);
    // Mercator inflates ground distances by 1/cos(60) == 2.
    expectClose(sixty / equator, 2, 1e-9);
    expectClose(equator, 1000 / ImmersiveMapProjection.earthCircumferenceMeters, 1e-15);
  });

  test("units per meter clamp beyond the Mercator latitude limit", () => {
    const atLimit = ImmersiveMapProjection.worldUnitsPerMeter(ImmersiveMapProjection.maxMercatorLatitude, 1000);
    const beyondLimit = ImmersiveMapProjection.worldUnitsPerMeter((89.0 * Math.PI) / 180.0, 1000);
    expectClose(beyondLimit, atLimit, 1e-12);
  });

  /**
   * Render units re-normalize per integer zoom: the map size doubles, so a
   * meter-sized model doubles with it and stays glued to the map geometry.
   */
  test("the render map size doubles across an integer zoom", () => {
    const center = ImmersiveMapProjection.worldMercator(0.6, 0.4);
    const atFive = PresentationStateResolver.resolve(ImmersiveMapCameraState.make(center, 5.0, 0, 0), defaultPresentationSettings);
    const atSix = PresentationStateResolver.resolve(ImmersiveMapCameraState.make(center, 6.0, 0, 0), defaultPresentationSettings);
    expectClose(atSix.flatRenderState.renderMapSize / atFive.flatRenderState.renderMapSize, 2, 1e-9);
  });
});

describe("ImmersiveMapProjection and mercator.ts", () => {
  /** The prototype's degree helpers and the engine's projection are one Web Mercator. */
  test("agree on the normalized world", () => {
    for (const [lon, lat] of [
      [37.6175, 55.752],
      [-74.011, 40.715],
      [151.2, -33.87],
    ] as const) {
      const [x, y] = lonLatToWorld(lon, lat);
      const world = ImmersiveMapProjection.worldMercator((lat * Math.PI) / 180, (lon * Math.PI) / 180);
      expectClose(world[0], x, 1e-12);
      expectClose(world[1], y, 1e-12);
      const [lon2, lat2] = worldToLonLat(world[0], world[1]);
      expectClose(lon2, lon, 1e-9);
      expectClose(lat2, lat, 1e-9);
    }
  });

  test("a tile's origin and size in the flat render world", () => {
    // Zoom 1, the camera at the world's centre (pan 0): tile (0, 0) is the
    // north-west quarter, its origin at (-size/2, 0) in a y-up world.
    const tile = ImmersiveMapProjection.flatTileOriginAndSize(0, 0, 1, 0, [0, 0], 100);
    expect(tile).toEqual([-50, 0, 50]);
    const wrapped = ImmersiveMapProjection.flatTileOriginAndSize(1, 1, 1, 1, [0, 0], 100);
    expect(wrapped).toEqual([100, -50, 50]);
  });
});
