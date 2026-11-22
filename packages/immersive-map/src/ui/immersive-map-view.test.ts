// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCity } from "../geo/immersive-map-city.ts";
import { cameraPositionFromOption, makeFrameEvent, viewFromCameraPosition } from "./immersive-map-view.ts";

describe("camera options", () => {
  const current = ImmersiveMapCameraPosition.make(55.75, 37.62, 12, 0.5, 0.3);

  test("a view sets what it names and keeps the rest", () => {
    expect(cameraPositionFromOption({ zoom: 15 }, current)).toEqual({ ...current, zoom: 15 });
    expect(cameraPositionFromOption({ center: [2.29, 48.86], pitch: 1 }, current)).toEqual({
      latitudeDegrees: 48.86,
      longitudeDegrees: 2.29,
      zoom: 12,
      bearing: 0.5,
      pitch: 1,
    });
  });

  test("a city opens at its centre, at the city zoom unless one is given", () => {
    const paris = ImmersiveMapCity.coordinate("paris");
    expect(cameraPositionFromOption({ city: "paris" })).toEqual(ImmersiveMapCameraPosition.make(paris.latitude, paris.longitude, ImmersiveMapCameraPosition.cityZoom));
    expect(cameraPositionFromOption({ city: "paris", zoom: 15 }).zoom).toBe(15);
  });

  test("a camera position is taken as it is", () => {
    expect(cameraPositionFromOption(current)).toBe(current);
  });

  test("a view and a position convert both ways", () => {
    const view = viewFromCameraPosition(current);
    expect(view).toEqual({ center: [37.62, 55.75], zoom: 12, bearing: 0.5, pitch: 0.3 });
    expect(cameraPositionFromOption(view)).toEqual(current);
  });
});

describe("makeFrameEvent", () => {
  test("the frame's time and the working set's counts", () => {
    const event = makeFrameEvent({
      frameNumber: 7,
      cpuStart: 100,
      cpuEnd: 102.5,
      gpuMilliseconds: 1.25,
      draws: 40,
      placement: { visibleTilesCount: 12, renderedTilesCount: 14, requestedTilesCount: 3 },
      transition: 1,
      pendingTerrainTiles: 2,
      pendingLayerMeshes: 1,
      drawnAppLayers: 4,
    });
    expect(event).toEqual({
      frameNumber: 7,
      cpuMilliseconds: 2.5,
      gpuMilliseconds: 1.25,
      draws: 40,
      visibleTiles: 12,
      renderedTiles: 14,
      loadingTiles: 3,
      pendingTerrainTiles: 2,
      pendingLayerMeshes: 1,
      pendingSceneModelMeshes: 0,
      drawnAppLayers: 4,
      transition: 1,
      hasPendingWork: true,
    });
  });

  test("nothing on its way is no pending work, any count of it is", () => {
    const frame = (requested: number, terrain: number, layers: number, models = 0) =>
      makeFrameEvent({
        frameNumber: 1,
        cpuStart: 0,
        cpuEnd: 1,
        gpuMilliseconds: undefined,
        draws: 0,
        placement: { visibleTilesCount: 4, renderedTilesCount: 4, requestedTilesCount: requested },
        transition: 1,
        pendingTerrainTiles: terrain,
        pendingLayerMeshes: layers,
        pendingSceneModelMeshes: models,
      }).hasPendingWork;
    expect([frame(0, 0, 0), frame(1, 0, 0), frame(0, 1, 0), frame(0, 0, 1), frame(0, 0, 0, 1)]).toEqual([false, true, true, true, true]);
  });

  test("a clock that steps back gives no negative time", () => {
    const event = makeFrameEvent({
      frameNumber: 1,
      cpuStart: 5,
      cpuEnd: 4,
      gpuMilliseconds: undefined,
      draws: 0,
      placement: { visibleTilesCount: 0, renderedTilesCount: 0, requestedTilesCount: 0 },
      transition: 0,
    });
    expect(event.cpuMilliseconds).toBe(0);
  });
});
