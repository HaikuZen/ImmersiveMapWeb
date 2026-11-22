// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { type Mat4, mat4FromColumns, mat4TransformVec4, mat4Transpose } from "../math/matrix.ts";
import { cross3, dot3, length2, sub3, type Vec2, type Vec3 } from "../math/vec.ts";
import { GlobeUnrollMath } from "./globe-unroll-math.ts";

/**
 * Swift `GlobeUnrollFoldTests`. A fold of the unroll flips a triangle's
 * screen winding, and back-face culling then draws far-side geometry over
 * the near map (the mid-morph "wedge" artifact). Folding is
 * machine-decidable: the morph maps (latitude, longitude) onto the growing
 * sphere, and its surface normal (the cross product of the two coordinate
 * tangents) must point outward from that sphere's centre. A sphere cannot
 * unroll without a cut, so fold-freedom cannot hold globally. What must
 * hold, and what this sweep of `GlobeUnrollMath.worldPosition` pins, is
 * that every fold is harmless: either inside the unroll's cut (which the
 * morph vertex stage clips) or painting at least half a radius from the
 * view centre, far off-screen at the zooms the morph runs at.
 */
describe("GlobeUnrollMath folds", () => {
  const radius = 1000;

  function rotationMatrix(panLatitude: number): Mat4 {
    // The pan rotation exactly as the globe's frame constants build it (pan
    // longitude 0: folds are longitude-symmetric).
    const cx = Math.cos(-panLatitude);
    const sx = Math.sin(-panLatitude);
    const m = mat4FromColumns([1, 0, 0, 0], [0, cx, sx, 0], [0, -sx, cx, 0], [0, 0, 0, 1]);
    return mat4Transpose(m, m);
  }

  function sphereWorld(latitude: number, longitude: number, rotation: Mat4): Vec3 {
    const phi = latitude - Math.PI / 2;
    const theta = longitude + Math.PI;
    const rotated = mat4TransformVec4(rotation, [
      Math.sin(phi) * Math.sin(theta) * radius,
      Math.cos(phi) * radius,
      Math.sin(phi) * Math.cos(theta) * radius,
      1,
    ]);
    return [rotated[0], rotated[1], rotated[2] - radius];
  }

  function flatWorld(latitude: number, longitude: number, panLatitude: number, transition: number, referenceX: number | null): Vec2 {
    // Mirror of globeTransitionMapSize / globeFlatWorldPosition at pan longitude 0.
    const mapSize = 2 * Math.PI * radius * ((1 - transition) * Math.cos(panLatitude) + transition);
    const half = mapSize * 0.5;
    const normalizedX = (longitude + Math.PI) / (2 * Math.PI);
    let x = ImmersiveMapProjection.wrap(normalizedX * mapSize - half, mapSize);
    if (referenceX !== null) {
      while (x - referenceX > half) x -= mapSize;
      while (referenceX - x > half) x += mapSize;
    }
    const mercY = ImmersiveMapProjection.yMercatorNormalized(latitude);
    const panMercY = ImmersiveMapProjection.yMercatorNormalized(panLatitude);
    return [x, (mercY - panMercY) * half];
  }

  function morphPosition(
    latitude: number,
    longitude: number,
    panLatitude: number,
    transition: number,
    rotation: Mat4,
    referenceX: number | null,
  ): { position: Vec3; flatX: number } {
    const sphere = sphereWorld(latitude, longitude, rotation);
    const flat = flatWorld(latitude, longitude, panLatitude, transition, referenceX);
    return { position: GlobeUnrollMath.worldPosition(sphere, flat, transition, radius), flatX: flat[0] };
  }

  test("the cut travel is the shader's", () => {
    expect(GlobeUnrollMath.cutTravelFraction).toBe(0.25);
  });

  test("every fold and traveller is cut or paints far off screen", () => {
    const panLatitudes = [0, 0.7, -0.7, 0.98, 1.05, -1.05, 1.31];
    const transitions = [0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98];
    const step = (3.0 * Math.PI) / 180.0;
    const h = (0.02 * Math.PI) / 180.0;
    const maxLat = (84.0 * Math.PI) / 180.0;
    const violations: string[] = [];
    let checked = 0;

    for (const panLatitude of panLatitudes) {
      const rotation = rotationMatrix(panLatitude);
      for (const transition of transitions) {
        const curvature = (1 - transition) / radius;
        const unrollCenterZ = -1 / curvature;
        for (let latitude = -maxLat; latitude <= maxLat; latitude += step) {
          for (let longitude = (-177.0 * Math.PI) / 180.0; longitude <= (177.5 * Math.PI) / 180.0; longitude += step) {
            const center = morphPosition(latitude, longitude, panLatitude, transition, rotation, null);
            const dLat = morphPosition(latitude + h, longitude, panLatitude, transition, rotation, center.flatX);
            const dLon = morphPosition(latitude, longitude + h, panLatitude, transition, rotation, center.flatX);
            const normal = cross3(sub3(dLat.position, center.position), sub3(dLon.position, center.position));
            const outward: Vec3 = [center.position[0], center.position[1], center.position[2] - unrollCenterZ];
            const orientation = dot3(normal, outward);
            checked += 1;
            // The sphere's own orientation at transition 0 is the reference:
            // d/dLat x d/dLon points inward on this parametrization, so a
            // healthy sample is negative.
            const sphere = sphereWorld(latitude, longitude, rotation);
            const flat = flatWorld(latitude, longitude, panLatitude, transition, center.flatX);
            const clipped = GlobeUnrollMath.cutClearance(sphere, flat, transition, radius) < 0;
            const paintRadius = Math.hypot(center.position[0], center.position[1]);
            const chart = GlobeUnrollMath.chartAE(sphere, radius);
            const travel = length2([flat[0] - chart[0], flat[1] - chart[1]]);
            // Two harms, both must be absent among unclipped content anywhere
            // near the view: a fold (flipped winding paints garbage) and a
            // long-haul traveller crossing the visible region on its way home.
            const harmfulFold = !clipped && orientation > 0 && paintRadius < 0.5 * radius;
            const harmfulTourist = !clipped && travel > 0.6 * radius && paintRadius < 0.4 * radius;
            if ((harmfulFold || harmfulTourist) && violations.length < 8) {
              violations.push(`pan ${panLatitude} t ${transition} lat ${(latitude * 180) / Math.PI} lon ${(longitude * 180) / Math.PI}`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
    expect(violations, `harmful folds of ${checked}`).toEqual([]);
  });
});
