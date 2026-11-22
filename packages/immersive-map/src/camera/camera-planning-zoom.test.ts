// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { cameraSettings } from "../configuration/camera-settings.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import type { Vec2 } from "../math/vec.ts";
import { defaultCameraPresentationSettings } from "../presentation/camera-presentation-settings.ts";
import { CameraStateController } from "./camera-state-controller.ts";
import { FrameCameraStateResolver } from "./frame-camera-state-resolver.ts";
import { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import { CameraTerrainFollow } from "./relief/camera-terrain-follow.ts";

/**
 * The planning zoom (`CameraStateController.planningZoom`): the zoom the
 * tiles, the rings and the relief's thresholds are planned by. It moves with
 * a zoom set on purpose and with nothing else, and then takes the camera's
 * zoom: over the terrain the camera's own zoom follows the ground under the
 * point it looks at, the planning zoom stands through every drag, and the
 * next zoom brings the two together.
 */
describe("CameraPlanningZoom", () => {
  const centre: Vec2 = [0.3, 0.4];

  function makeController(zoom = 12, maximumZoom = 22): CameraStateController {
    const controller = new CameraStateController(cameraSettings({ maximumZoom }));
    controller.setCameraState(ImmersiveMapCameraState.make(centre, zoom, 0, 0.6));
    return controller;
  }

  function slope(): CameraTerrainFollow {
    // Level at the start, a slope rising to the north: a drag north moves the
    // point looked at uphill, and the camera's zoom with it.
    const origin = centre;
    return new CameraTerrainFollow({
      terrainMetres: (point) => Math.max(0, (point[1] - origin[1]) * -4_000_000),
      clearanceMetres: 0,
      globeRadiusScale: defaultPresentationSettings.globeRadiusScale,
    });
  }

  test("a zoom set outright sets both zooms", () => {
    const controller = makeController(12);
    expect(controller.planningZoom).toBe(12);
    controller.setCameraPosition(ImmersiveMapCameraPosition.make(46, 7, 9, 0, 0));
    expect(controller.planningZoom).toBe(9);
    expect(controller.zoom).toBe(9);
    controller.setZoom(14.5);
    expect(controller.planningZoom).toBe(14.5);
    expect(controller.zoom).toBe(14.5);
  });

  test("a zoom gesture brings the planning zoom to the camera's", () => {
    const controller = makeController(12);
    controller.zoomByDelta(1.25);
    expect(controller.planningZoom).toBeCloseTo(13.25, 9);
    expect(controller.zoom).toBeCloseTo(13.25, 9);
    controller.zoomByDelta(20);
    expect(controller.planningZoom, "Clamped to the zoom range like the camera's").toBe(22);
    expect(controller.zoom).toBe(22);
  });

  /**
   * A climb parts the two zooms, and the next zoom gesture closes the gap at
   * the camera's zoom. Not by the gesture's delta: a zoom back by what the
   * climb added would then leave the map planned levels below what the
   * camera sees.
   */
  test("a drag over the terrain moves the camera zoom and not the planning zoom", () => {
    const controller = makeController(12);
    controller.terrainFollow = slope();
    controller.pan(0, 1, 1);
    controller.pan(0, 1, 1);
    controller.endPan();
    const climbed = controller.zoom;
    expect(climbed, "Uphill the camera's zoom follows the ground").not.toBe(12);
    expect(controller.planningZoom, "The planning zoom stands").toBe(12);
    controller.zoomByDelta(12 - climbed);
    expect(Math.abs(controller.zoom - 12), "Zoomed back by the climb").toBeLessThan(1e-6);
    expect(controller.planningZoom, "And the map is planned by what the camera sees").toBeCloseTo(controller.zoom, 9);
  });

  test("the frame carries the planning zoom", () => {
    const resolver = new FrameCameraStateResolver(defaultCameraPresentationSettings);
    resolver.setCameraPosition(ImmersiveMapCameraPosition.make(46, 7, 11, 0, 0));
    expect(resolver.planningZoom).toBe(11);
    const state = resolver.makeFrameState(400, 300);
    expect(state?.planningZoom).toBe(11);
  });
});
