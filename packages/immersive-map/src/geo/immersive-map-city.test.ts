// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCity } from "./immersive-map-city.ts";

describe("ImmersiveMapCity", () => {
  test("every city has a name and a coordinate", () => {
    const cities = ImmersiveMapCity.allCases;
    expect(cities.length).toBe(71);
    expect(new Set(cities.map((city) => ImmersiveMapCity.name(city))).size).toBe(cities.length);
    for (const city of cities) {
      expect(ImmersiveMapCity.name(city), city).not.toBe("");
      const coordinate = ImmersiveMapCity.coordinate(city);
      expect(coordinate.latitude >= -85 && coordinate.latitude <= 85, city).toBe(true);
      expect(coordinate.longitude >= -180 && coordinate.longitude <= 180, city).toBe(true);
    }
  });

  /** No two cities share a place: a pasted row would. */
  test("no two cities share a coordinate", () => {
    const keys = ImmersiveMapCity.allCases.map((city) => {
      const coordinate = ImmersiveMapCity.coordinate(city);
      return `${coordinate.latitude},${coordinate.longitude}`;
    });
    expect(new Set(keys).size).toBe(ImmersiveMapCity.allCases.length);
  });

  test("a city's camera position is over its centre", () => {
    const position = ImmersiveMapCameraPosition.city("paris");
    expect(position.latitudeDegrees).toBe(ImmersiveMapCity.coordinate("paris").latitude);
    expect(position.longitudeDegrees).toBe(ImmersiveMapCity.coordinate("paris").longitude);
    expect(position.zoom).toBe(ImmersiveMapCameraPosition.cityZoom);
    expect(position.bearing).toBe(0);
    expect(position.pitch).toBe(0);

    const tilted = ImmersiveMapCameraPosition.city("tokyo", 13, 0.5, 1);
    expect(tilted.zoom).toBe(13);
    expect(tilted.bearing).toBe(0.5);
    expect(tilted.pitch).toBe(1);
  });
});
