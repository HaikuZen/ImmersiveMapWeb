// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { Matrix } from "../math/matrix.ts";
import type { Vec2 } from "../math/vec.ts";
import { visibleQuarters } from "../tile/visibility/quarter-frustum.ts";
import { ShadowCasterRegionResolver } from "./shadow-caster-region.ts";
import { ShadowMapReuseController } from "./shadow-map-reuse-controller.ts";

const renderMapSize = 1024;
const pan: Vec2 = [0, 0];
const keyOf = (x: number, y: number, z: number) => ShadowMapReuseController.casterKey({ resident: {}, placeIn: { tile: { x, y, z }, worldWrap: 0 }, quarters: 0b1111 });
// A light straight down over the square from -64 to 64 in world xy: clip x and y are the world's over 64.
const lightProjectionView = Matrix.metalOrthographicMatrix(new Float64Array(16), -64, 64, -64, 64, -100, 100);

describe("ShadowCasterRegionResolver", () => {
  test("a caster's tile maps to its texels, a texel wider on every side", () => {
    // Tile 512/512 at zoom 10 spans world x 0 to 1 and y -1 to 0 (the row grows south).
    const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(512, 512, 10, 0, pan, renderMapSize);
    expect([ox, oy, size]).toEqual([0, -1, 1]);
    const region = ShadowCasterRegionResolver.resolve([keyOf(512, 512, 10)], lightProjectionView, pan, renderMapSize, [0, 0], 1024)!;
    // x 0 to 1 is texels 512 to 520, y -1 to 0 is texels 512 to 520 (v grows down): one texel more each side.
    expect(region.scissor).toEqual([511, 511, 10, 10]);
  });

  test("the cropped camera culls what lies outside the region", () => {
    const region = ShadowCasterRegionResolver.resolve([keyOf(512, 512, 10)], lightProjectionView, pan, renderMapSize, [0, 0], 1024)!;
    expect(visibleQuarters(region.cullingProjectionView, 0, -1, 1, 0, 0b1111, true)).toBe(0b1111);
    expect(visibleQuarters(region.cullingProjectionView, 4, -1, 1, 0, 0b1111, true)).toBe(0);
    expect(visibleQuarters(lightProjectionView, 4, -1, 1, 0, 0b1111, true)).toBe(0b1111);
  });

  test("the rectangle holds every changed caster", () => {
    const region = ShadowCasterRegionResolver.resolve([keyOf(512, 512, 10), keyOf(515, 510, 10)], lightProjectionView, pan, renderMapSize, [0, 0], 1024)!;
    // x 0 to 4 and y -1 to 2.
    expect(region.scissor).toEqual([511, 495, 34, 26]);
  });

  test("casters outside the window clamp to the slice", () => {
    const region = ShadowCasterRegionResolver.resolve([keyOf(600, 512, 10)], lightProjectionView, pan, renderMapSize, [0, 0], 1024)!;
    expect(region.scissor[2] * region.scissor[3]).toBe(0);
  });

  test("a region over half the slice is no region", () => {
    // Zoom 3 tiles span 128 world units a side, each over a quarter of the window: three of them cover three quarters.
    expect(ShadowCasterRegionResolver.resolve([keyOf(3, 3, 3), keyOf(4, 3, 3), keyOf(3, 4, 3)], lightProjectionView, pan, renderMapSize, [0, 0], 1024)).toBeUndefined();
    expect(ShadowCasterRegionResolver.resolve([keyOf(3, 3, 3)], lightProjectionView, pan, renderMapSize, [0, 0], 1024)).toBeDefined();
  });
});
