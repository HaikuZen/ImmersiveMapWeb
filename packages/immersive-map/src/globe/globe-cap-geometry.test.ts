// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeCapPaletteTests`, and the winding the Swift
// `GlobeCapOffscreenRenderTests` pins on the GPU, checked on the CPU.

import { describe, expect, test } from "vitest";
import { WebMercatorMath } from "../math/web-mercator-math.ts";
import { defaultTheme, themeBaseColors } from "../style/theme.ts";
import { GlobeCapGeometry, GlobeCapPalette } from "./globe-cap-geometry.ts";

describe("GlobeCapPalette", () => {
  test("the north pole follows the style, made opaque", () => {
    const palette = GlobeCapPalette.make({ map: [0.09, 0.1, 0.13, 1], northCap: [0.04, 0.09, 0.2, 0.5], southCap: [0.3, 0.32, 0.36, 1] });
    expect(palette.north).toEqual([0.04, 0.09, 0.2, 1]);
  });

  test("the south pole follows the style", () => {
    const palette = GlobeCapPalette.make({ map: [0.09, 0.1, 0.13, 1], northCap: [0.04, 0.09, 0.2, 1], southCap: [0.3, 0.32, 0.36, 1] });
    expect(palette.south).toEqual([0.3, 0.32, 0.36, 1]);
  });

  test("the built-in style's caps are its theme's water and ice", () => {
    const palette = GlobeCapPalette.make(themeBaseColors(defaultTheme));
    const opaque = (c: readonly number[]) => [c[0], c[1], c[2], 1];
    expect(palette.north).toEqual(opaque(defaultTheme.layers.water));
    expect(palette.south).toEqual(opaque(defaultTheme.layers.ice));
  });
});

describe("GlobeCapGeometry", () => {
  const maxLatitude = WebMercatorMath.maxLatitudeRadians;

  /** The cap's vertex on the unit sphere, as globe-cap.wgsl places it. */
  const position = (lat: number, lon: number) => {
    const phi = lat - Math.PI / 2;
    return [Math.sin(phi) * Math.sin(lon), Math.cos(phi), Math.sin(phi) * Math.cos(lon)] as const;
  };

  for (const isNorth of [true, false]) {
    test(`the ${isNorth ? "north" : "south"} cap reaches its pole from just inside the last tile row`, () => {
      const grid = GlobeCapGeometry.createCapGrid(12, 48, isNorth, maxLatitude);
      expect(grid.latLon.length).toBe(13 * 49 * 2);
      expect(grid.indices).toBeInstanceOf(Uint16Array);
      const lats = grid.latLon.filter((_, i) => i % 2 === 0);
      const edge = isNorth ? Math.min(...lats) : Math.max(...lats);
      const pole = isNorth ? Math.max(...lats) : Math.min(...lats);
      expect(edge).toBeCloseTo(isNorth ? maxLatitude - GlobeCapGeometry.boundaryOverlapRadians : -maxLatitude + GlobeCapGeometry.boundaryOverlapRadians, 6);
      expect(Math.abs(pole)).toBeCloseTo(Math.PI / 2, 6);
    });

    test(`the ${isNorth ? "north" : "south"} cap's triangles face out of the sphere`, () => {
      const grid = GlobeCapGeometry.createCapGrid(12, 48, isNorth, maxLatitude);
      let outward = 0;
      let inward = 0;
      for (let t = 0; t < grid.indices.length; t += 3) {
        const vertex = (k: number) => {
          const v = grid.indices[t + k]!;
          return position(grid.latLon[v * 2]!, grid.latLon[v * 2 + 1]!);
        };
        const [a, b, c] = [vertex(0), vertex(1), vertex(2)];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
        const length = Math.hypot(n[0]!, n[1]!, n[2]!);
        // Triangles at the pole collapse to a line.
        if (length < 1e-9) continue;
        const centre = [0, 1, 2].map((k) => a[k]! + b[k]! + c[k]!);
        const facing = n[0]! * centre[0]! + n[1]! * centre[1]! + n[2]! * centre[2]!;
        if (facing > 0) outward++;
        else inward++;
      }
      // Counter-clockwise seen from outside: the normal of the
      // right-handed winding points out of the sphere.
      expect(inward).toBe(0);
      expect(outward).toBeGreaterThan(0);
    });
  }
});
