// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../camera/render-camera-pose-resolver.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import { TileGridSelectionSnapshot } from "../tile-grid/selection/tile-grid-selection-snapshot.ts";
import { GeoScreenPlaceMath } from "./geo-screen-place-math.ts";
import { GeoScreenProjectionFrameConstants } from "./geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

const drawWidth = 800;
const drawHeight = 600;
const degrees = Math.PI / 180;

/** The projection of a frame over Moscow, the camera assembled as the renderer assembles it. */
function projection(zoom: number, pitchDegrees: number): GeoScreenProjectionFrameConstants {
  const center = ImmersiveMapProjection.worldMercator(55.75 * degrees, 37.61 * degrees);
  const cameraState = ImmersiveMapCameraState.make(center, zoom, 20 * degrees, pitchDegrees * degrees);
  const presentation = PresentationStateResolver.resolve(cameraState, defaultPresentationSettings);
  const camera = new RenderCamera();
  camera.recalculateProjection(drawWidth / drawHeight);
  new RenderCameraPoseResolver().updateIfNeeded(camera, cameraState, presentation.presentationState.transition);
  return new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, { matrix: camera.cameraMatrix!.slice(), eye: camera.eye }, presentation);
}

/** The pixels of the lower half of the screen, which under any of the pitches below shows the ground. */
function lowerHalf(): [number, number][] {
  const pixels: [number, number][] = [];
  for (let y = 5; y < drawHeight / 2; y += 25) for (let x = 5; x < drawWidth; x += 25) pixels.push([x, y]);
  return pixels;
}

describe("GeoScreenPlaceMath", () => {
  // The search once measured its first slope over a thousandth of the world:
  // tens of tiles at a street's zoom, which a tilted camera puts behind it, and
  // a tile at a city's, over which the perspective of a steep one turns the
  // search away from the pixel. A tap then found no place on the map.
  for (const zoom of [10, 15, 18]) {
    for (const pitch of [30, 60, 80]) {
      test(`every pixel of the ground has its place at zoom ${zoom}, pitch ${pitch}°`, () => {
        const frame = projection(zoom, pitch);
        expect(frame.mode).toBe("flat");
        for (const pixel of lowerHalf()) {
          const place = GeoScreenPlaceMath.place(pixel, frame);
          expect(place, `pixel ${pixel.join(",")}`).toBeDefined();
          const there = GeoScreenPlaceMath.project(place!.world, frame)!;
          expect(Math.hypot(there[0] - pixel[0], there[1] - pixel[1])).toBeLessThan(0.25);
        }
      });
    }
  }

  test("a tap on a tilted tile grid finds the tile under it", () => {
    const frame = projection(16, 60);
    const snapshot = new TileGridSelectionSnapshot(1, drawWidth, drawHeight, frame, 16, "tap", "multiple", null, null);
    const pixel: [number, number] = [620, 120];
    const hit = snapshot.hitTest({ x: pixel[0], y: pixel[1] })!;
    expect(hit).toBeDefined();
    const place = GeoScreenPlaceMath.place(pixel, frame)!;
    expect(hit.tile.zoom).toBe(16);
    expect(hit.tile.x).toBe(Math.floor(place.world[0] * 2 ** 16));
    expect(hit.tile.y).toBe(Math.floor(place.world[1] * 2 ** 16));
  });
});
