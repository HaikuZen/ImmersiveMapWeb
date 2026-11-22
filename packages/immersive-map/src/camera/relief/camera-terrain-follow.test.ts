// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { cameraSettings } from "../../configuration/camera-settings.ts";
import { defaultPresentationSettings } from "../../configuration/presentation-settings.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import { CameraStateController } from "../camera-state-controller.ts";
import { ImmersiveMapCameraState } from "../immersive-map-camera-state.ts";
import { CameraTerrainFollow } from "./camera-terrain-follow.ts";

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

const centre: Vec2 = [0.3, 0.4];
const globeRadiusScale = defaultPresentationSettings.globeRadiusScale;
const range = { lowerBound: 0, upperBound: 22 };
const centreLatitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(centre[1]);
const metresPerWorld = ImmersiveMapProjection.earthCircumferenceMeters * Math.cos(centreLatitude);

function follow(terrainMetres: (point: Vec2) => number | null, clearance = 30, sampleStepWorld = 0): CameraTerrainFollow {
  return new CameraTerrainFollow({ terrainMetres, clearanceMetres: clearance, globeRadiusScale, sampleStepWorld });
}

function controllerAt(zoom: number, pitch: number): CameraStateController {
  const controller = new CameraStateController(cameraSettings({ maximumZoom: 22 }));
  controller.setCameraState(ImmersiveMapCameraState.make(centre, zoom, 0, pitch));
  return controller;
}

/**
 * The camera over a terrain looks at a point on it: the zoom stops where the
 * eye would come nearer than the clearance to that point or to the terrain
 * under the eye, and a pan keeps the eye's height by the zoom.
 */
describe("CameraTerrainFollow", () => {
  test("the eye comes down as the zoom grows", () => {
    const level = follow(() => 0);
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 60; step++) {
      const height = level.eyeHeightMetres(step * 0.25, 0, centreLatitude);
      expect(height, `The height falls through zoom ${step * 0.25}`).toBeLessThan(previous);
      previous = height;
    }
  });

  /**
   * The point looked at lies on the plateau, level with the ground under the
   * eye: nothing holds the eye off it, and the zoom goes to its own limit,
   * however high the plateau.
   */
  test("a plateau does not stop the zoom", () => {
    const plateau = follow(() => 1000);
    expect(plateau.clearZoom(22, centre, 0, 0, range)).toBe(22);
    expect(plateau.clearZoom(22, centre, 1, 2, range)).toBe(22);
    expect(plateau.isClear(centre, 22, 1, 2)).toBe(true);
  });

  /**
   * The margin grows with the ridge's rise over the point: none for a ridge
   * level with it, the whole clearance a clearance up, smoothly between, and
   * none at all without a clearance: the eye then stops at the ridge's own
   * surface.
   */
  test("the margin grows with the ridge", () => {
    expect(CameraTerrainFollow.clearanceMargin(500, 0), "Right up to the ridge").toBe(0);
    expect(CameraTerrainFollow.clearanceMargin(0, 30)).toBe(0);
    expect(CameraTerrainFollow.clearanceMargin(-100, 30)).toBe(0);
    expect(CameraTerrainFollow.clearanceMargin(30, 30)).toBe(30);
    expect(CameraTerrainFollow.clearanceMargin(500, 30)).toBe(30);
    expectClose(CameraTerrainFollow.clearanceMargin(15, 30), 15, 1e-9);
    let previous = 0;
    for (let step = 1; step <= 30; step++) {
      const margin = CameraTerrainFollow.clearanceMargin(step, 30);
      expect(margin).toBeGreaterThanOrEqual(previous);
      previous = margin;
    }
  });

  /** At a pitch the eye stands behind the point it looks at: a hill there, and nowhere else, is what stops the zoom. */
  test("the terrain under the eye is what counts", () => {
    // A hill right behind the centre to the south, where a camera looking
    // north stands at any zoom.
    const hill = follow((point) => (point[1] > centre[1] + 1e-9 ? 500 : 0));
    const flatLimit = hill.clearZoom(22, centre, 0, 0, range);
    const pitchedLimit = hill.clearZoom(22, centre, Math.PI / 3, 0, range);
    expect(pitchedLimit, "The hill under the pitched eye stops it far sooner").toBeLessThan(flatLimit - 1);
  });

  test("unknown terrain stops nothing", () => {
    expect(follow(() => null).clearZoom(22, centre, 0, 0, range)).toBe(22);
  });

  /**
   * A pan onto higher ground keeps the eye's altitude: the point looked at
   * rises with the terrain and the zoom shortens the arm to it, so the eye's
   * altitude is what it was, and the eye's place over the map moved by the
   * pan, no more and no less.
   */
  test("a pan onto higher ground keeps the eye's altitude", () => {
    const pitch = Math.PI / 4;
    const controller = controllerAt(14, pitch);
    // A ramp rising north at two metres a metre, steeper than the ray's one,
    // from 30 m short of where the pan would put the point: the ray meets its
    // face, and the point stops on it.
    const rampY = centre[1] - 1e-5 + 30 / metresPerWorld;
    const terrain = (point: Vec2): number | null => Math.max(0, (rampY - point[1]) * metresPerWorld * 2);
    const ramp = follow(terrain);
    controller.terrainFollow = ramp;
    const altitudeBefore = ramp.eyeHeightMetres(14, pitch, centreLatitude);
    const eyeBefore = ramp.eyeGround(centre, 14, pitch, 0, centreLatitude);

    const target: Vec2 = [centre[0], centre[1] - 1e-5];
    const followed = controller.followTerrain(centre, target, ramp);
    expect(followed.zoom, "The arm shortens: a deeper zoom").toBeGreaterThan(14);
    const heightAfter = terrain(followed.center) ?? 0;
    expect(heightAfter, "The point is on the ramp").toBeGreaterThan(1);
    expectClose(heightAfter + ramp.eyeHeightMetres(followed.zoom, pitch, centreLatitude), altitudeBefore, 0.5);
    const eyeAfter = ramp.eyeGround(followed.center, followed.zoom, pitch, 0, centreLatitude);
    expectClose((eyeAfter[1] - eyeBefore[1]) * metresPerWorld, (target[1] - centre[1]) * metresPerWorld, 0.2, "The eye moved over the map by the pan");
  });

  /**
   * Looking straight down the eye has no reach, and the march along its ray
   * must still take a sample, one terrain texel long though the ray meets the
   * ground under the eye: a pan over a slope keeps the eye's altitude, with
   * the slope's rise in the zoom, and never falls back to the plain pan that
   * rode the slope.
   */
  test("a pan looking straight down keeps the eye's altitude", () => {
    const controller = controllerAt(13, 0);
    // A slope rising north at a metre in ten.
    const terrain = (point: Vec2): number | null => (centre[1] - point[1]) * metresPerWorld * 0.1;
    // A texel of thirty metres, longer than the march's reach of nothing.
    const slope = follow(terrain, 30, 30 / metresPerWorld);
    controller.terrainFollow = slope;
    const altitudeBefore = slope.eyeHeightMetres(13, 0, centreLatitude);

    const target: Vec2 = [centre[0], centre[1] - 2000 / metresPerWorld];
    const followed = controller.followTerrain(centre, target, slope);
    expectClose(followed.center[1], target[1], 0.2 / metresPerWorld, "The point is where the pan put it");
    expect(followed.zoom, "The slope's rise is in the zoom").toBeGreaterThan(13);
    // The height by the zoom is read at the point's own latitude, as the
    // settle reads it.
    const latitudeAfter = ImmersiveMapProjection.latitudeFromNormalizedWorldY(followed.center[1]);
    const altitudeAfter = (terrain(followed.center) ?? 0) + slope.eyeHeightMetres(followed.zoom, 0, latitudeAfter);
    expectClose(altitudeAfter, altitudeBefore, 0.5, "The eye keeps its altitude over the slope");
  });

  /** Onto a mountain higher than the eye, the eye rises: the point looked at keeps the clearance under the eye. */
  test("a pan onto a mountain lifts the eye to the clearance", () => {
    const controller = controllerAt(16, 0);
    const mountain = follow((point) => (point[1] < centre[1] - 1e-9 ? 3000 : 0));
    const followed = controller.followTerrain(centre, [centre[0], centre[1] - 1e-5], mountain);
    expectClose(mountain.eyeHeightMetres(followed.zoom, 0, centreLatitude), 30, 0.1);
  });

  /**
   * A zoom out that crosses onto a coarser terrain map, which reads the
   * ground under the point higher than the finer one did, keeps the eye where
   * the zoom put it: the point moves up the ray to where it meets the higher
   * ground, the arm shortens, and the eye's altitude is the old ground plus
   * the new zoom's height, no jump.
   */
  test("a zoom onto another terrain map keeps the eye", () => {
    const pitch = Math.PI / 4;
    const controller = controllerAt(12.5, pitch);
    // The finer map, read at zoom 12 and deeper, has the ground at 1000 m.
    // The coarser one, read below 12, has it at 1300 m.
    const maps = follow(() => (controller.zoom >= 12 ? 1000 : 1300));
    controller.terrainFollow = maps;
    const expectedAltitude = 1000 + maps.eyeHeightMetres(11.5, pitch, centreLatitude);
    const expectedEye = maps.eyeGround(centre, 11.5, pitch, 0, centreLatitude);

    controller.zoomByDelta(-1);
    expect(controller.zoom, "The point met higher ground sooner: a shorter arm").toBeGreaterThan(11.5);
    const altitude = 1300 + maps.eyeHeightMetres(controller.zoom, pitch, centreLatitude);
    expectClose(altitude, expectedAltitude, 0.5, "The eye is where the zoom put it");
    const eye = maps.eyeGround(controller.cameraState.centerWorldMercator, controller.zoom, pitch, 0, centreLatitude);
    expectClose((eye[1] - expectedEye[1]) * metresPerWorld, 0, 0.5, "And over the same ground");
    expect(controller.cameraState.centerWorldMercator, "The point moved along the ray").not.toEqual(centre);
  });

  /**
   * A pan that brings a ridge under the eye, higher than the eye is, backs
   * the eye off along its view ray by the zoom, to where it keeps the
   * clearance over the ridge: the frame never lifts the camera off its pose.
   */
  test("a pan under a ridge backs the eye off by the zoom", () => {
    const pitch = Math.PI / 4;
    const controller = controllerAt(16, pitch);
    const eyeHeight = follow(() => 0).eyeHeightMetres(16, pitch, centreLatitude);
    // Level ground at the point and north of it, a plateau twice the eye's
    // height just south of it: under the eye of a pitched camera looking
    // north, which stands south of the point.
    const ridge = follow((point) => (point[1] > centre[1] + 1e-7 ? eyeHeight * 2 : 0), 30);
    controller.terrainFollow = ridge;
    controller.pan(0, 1, 1);
    expect(controller.zoom, "The arm lengthened: the eye backed off").toBeLessThan(16);
    expect(ridge.isClear(controller.cameraState.centerWorldMercator, controller.zoom, pitch, 0), "And it is clear of the ridge").toBe(true);
  });

  /**
   * The anchor compensation of a zoom slides the point over the ground: onto
   * a ramp, the eye keeps the altitude the zoom gave it and the arm shortens,
   * as for a pan. Without a terrain the center is simply set.
   */
  test("an anchored zoom's slide onto a ramp keeps the eye", () => {
    const pitch = Math.PI / 4;
    const controller = controllerAt(14, pitch);
    const rampY = centre[1] - 1e-5 + 30 / metresPerWorld;
    const terrain = (point: Vec2): number | null => Math.max(0, (rampY - point[1]) * metresPerWorld * 2);
    const ramp = follow(terrain);
    controller.terrainFollow = ramp;
    const altitudeBefore = ramp.eyeHeightMetres(14, pitch, centreLatitude);

    controller.setCenterWorldMercatorOverTerrain([centre[0], centre[1] - 1e-5]);
    expect(controller.zoom, "The arm shortened onto the ramp").toBeGreaterThan(14);
    const height = terrain(controller.cameraState.centerWorldMercator) ?? 0;
    expect(height, "The point is on the ramp").toBeGreaterThan(1);
    expectClose(height + ramp.eyeHeightMetres(controller.zoom, pitch, centreLatitude), altitudeBefore, 0.5, "The eye kept its altitude");

    controller.terrainFollow = null;
    controller.setCenterWorldMercatorOverTerrain(centre);
    expect(controller.cameraState.centerWorldMercator, "Plainly set without a terrain").toEqual(centre);
  });

  /** A zoom that stays on one terrain map moves nothing but the zoom. */
  test("a zoom on one terrain map keeps the point", () => {
    const controller = controllerAt(12.5, Math.PI / 4);
    controller.terrainFollow = follow(() => 1000);
    controller.zoomByDelta(-1);
    expectClose(controller.zoom, 11.5, 1e-9);
    expect(controller.cameraState.centerWorldMercator).toEqual(centre);
  });

  test("the controller clamps a zoom in to the limit and lets a zoom out through", () => {
    const controller = controllerAt(10, 0);
    const plateau = follow(() => 1000);
    controller.terrainFollow = plateau;
    const limit = plateau.clearZoom(22, centre, 0, 0, range);

    controller.zoomByDelta(12);
    expectClose(controller.zoom, limit, 1e-6, "The zoom in stops at the terrain");
    controller.zoomByDelta(-3);
    expectClose(controller.zoom, limit - 3, 1e-6, "A zoom out is free");
  });
});
