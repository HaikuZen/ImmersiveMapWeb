// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../camera/render-camera-pose-resolver.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { GlobeUnrollMath } from "../globe/globe-unroll-math.ts";
import { mat4TransformVec4 } from "../math/matrix.ts";
import { cross3, dot3, length3, type Vec2, type Vec3 } from "../math/vec.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import { geoCoordinate } from "./geo-coordinate.ts";
import { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { GeoScreenProjectionFrameConstants, GeoScreenProjectionMath } from "./geo-screen-projection-math.ts";
import { GeoSurfaceFrameMath } from "./geo-surface-frame-math.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

const drawWidth = 800;
const drawHeight = 600;

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function expectVector(actual: Vec3, expected: Vec3, accuracy: number): void {
  for (let index = 0; index < 3; index++) {
    expectClose(actual[index]!, expected[index]!, accuracy);
  }
}

function makeConstants(latitude: number, longitude: number, zoom: number): GeoScreenProjectionFrameConstants {
  const center = ImmersiveMapProjection.worldMercator((latitude * Math.PI) / 180.0, (longitude * Math.PI) / 180.0);
  const cameraState = ImmersiveMapCameraState.make(center, zoom, 0, 0);
  const presentation = PresentationStateResolver.resolve(cameraState, defaultPresentationSettings);
  const camera = new RenderCamera();
  camera.recalculateProjection(drawWidth / drawHeight);
  new RenderCameraPoseResolver().updateIfNeeded(camera, cameraState, presentation.presentationState.transition);
  return new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, { matrix: camera.cameraMatrix!.slice(), eye: camera.eye }, presentation);
}

function screenPoint(worldPosition: Vec3, constants: GeoScreenProjectionFrameConstants): Vec2 | null {
  const clip = mat4TransformVec4(constants.cameraUniform.matrix, [worldPosition[0], worldPosition[1], worldPosition[2], 1.0]);
  if (!(clip[3] > 0)) {
    return null;
  }
  return [((clip[0] / clip[3]) * 0.5 + 0.5) * constants.viewport[0], ((clip[1] / clip[3]) * 0.5 + 0.5) * constants.viewport[1]];
}

const basisOf = (latitude: number, longitude: number): GeoProjectionBasis => GeoProjectionBasis.fromCoordinate(geoCoordinate(latitude, longitude));

/**
 * `GeoSurfaceFrameMath` is the single CPU evaluation of the sphere-plane
 * morph, shared by scene model anchors and route tessellation. It must agree
 * with `GeoScreenProjectionMath` (the CPU mirror of the globe shaders), and
 * it must keep a chain of points continuous across the antimeridian.
 */
describe("GeoSurfaceFrameMath", () => {
  // Agreement with the geo projector

  test("the globe frame matches the geo projector at transition zero", () => {
    const constants = makeConstants(10, 20, 1.0);
    expect(constants.mode).toBe("globe");
    expect(constants.globe.transition).toBe(0);
    for (const [latitude, longitude] of [
      [10.0, 20.0],
      [14.0, 26.0],
      [-3.0, 12.0],
    ] as const) {
      const basis = basisOf(latitude, longitude);
      const frame = GeoSurfaceFrameMath.resolve(basis, constants);
      const projected = GeoScreenProjectionMath.project(basis, constants);
      const screen = screenPoint(frame.worldPosition, constants)!;
      expect(projected.visible).not.toBe(0);
      expectClose(screen[0], projected.positionX, 0.01);
      expectClose(screen[1], projected.positionY, 0.01);
    }
  });

  test("a mid-morph frame rides the unroll", () => {
    const constants = makeConstants(0, 0, 6.3);
    expect(constants.mode).toBe("globe");
    expect(constants.globe.transition).toBeGreaterThan(0);
    expect(constants.globe.transition).toBeLessThan(1);

    const basis = basisOf(0.4, 0.6);
    const frame = GeoSurfaceFrameMath.resolve(basis, constants);
    const sphere = constants.rotatedSphereWorldPosition(basis.sphereUnit);
    const flat = constants.globeFlatWorldPosition(basis);
    const expected = GlobeUnrollMath.worldPosition(sphere, [flat[0], flat[1]], constants.globe.transition, constants.globe.radius);
    expectClose(frame.localTransition, constants.globe.transition, 1e-6);
    expectVector(frame.worldPosition, expected, 1e-5);
  });

  test("the flat frame matches the geo projector", () => {
    const constants = makeConstants(55.75, 37.61, 15.0);
    expect(constants.mode).toBe("flat");
    const basis = basisOf(55.79, 37.55);
    const frame = GeoSurfaceFrameMath.resolve(basis, constants);
    const projected = GeoScreenProjectionMath.project(basis, constants);
    const screen = screenPoint(frame.worldPosition, constants)!;
    expectClose(screen[0], projected.positionX, 0.01);
    expectClose(screen[1], projected.positionY, 0.01);
    expectVector(frame.up, [0, 0, 1], 1e-4);
  });

  // Tangent frame

  test("the tangent frame is orthonormal and right-handed", () => {
    for (const zoom of [1.0, 6.3, 6.7, 15.0]) {
      const constants = makeConstants(20, -30, zoom);
      for (const [latitude, longitude] of [
        [0.0, 0.0],
        [80.0, 179.9],
        [-80.0, -179.9],
        [45.0, 90.0],
      ] as const) {
        const frame = GeoSurfaceFrameMath.resolve(basisOf(latitude, longitude), constants);
        expectClose(length3(frame.east), 1, 1e-4);
        expectClose(length3(frame.north), 1, 1e-4);
        expectClose(length3(frame.up), 1, 1e-4);
        expectClose(dot3(frame.east, frame.north), 0, 1e-4);
        expectClose(dot3(frame.north, frame.up), 0, 1e-4);
        expectClose(dot3(frame.up, frame.east), 0, 1e-4);
        expectVector(cross3(frame.east, frame.north), frame.up, 1e-4);
      }
    }
  });

  // Meter scale

  test("the units per meter match the analytic scale at both ends", () => {
    const circumference = ImmersiveMapProjection.earthCircumferenceMeters;

    const globeConstants = makeConstants(0, 0, 1.0);
    const globeFrame = GeoSurfaceFrameMath.resolve(basisOf(10, 10), globeConstants);
    expectClose(globeFrame.unitsPerMeter, (2 * Math.PI * globeConstants.globe.radius) / circumference, 1e-9);

    const latitude = 55.75;
    const flatConstants = makeConstants(latitude, 37.61, 15.0);
    const flatFrame = GeoSurfaceFrameMath.resolve(basisOf(latitude, 37.61), flatConstants);
    const expected = flatConstants.flatRenderMapSize / (circumference * Math.cos((latitude * Math.PI) / 180.0));
    expectClose(flatFrame.unitsPerMeter, expected, expected * 1e-4);
  });

  // Antimeridian continuity

  /**
   * The flat morph target wraps into one map width, so two neighbours on
   * opposite sides of the seam jump by a whole world unless the chain is
   * unwrapped against the previous point. Anchoring a single model never hit
   * this, a ribbon does.
   */
  test("a chained resolve keeps the flat term continuous across the antimeridian", () => {
    // The wrap folds X into one map width centred on the camera, so the seam
    // sits opposite the camera: centring at longitude 0 puts it on the
    // antimeridian, where the pair below straddles it.
    const constants = makeConstants(0, 0, 6.5);
    expect(constants.mode).toBe("globe");
    expect(constants.globe.transition).toBeGreaterThan(0);

    const first = GeoSurfaceFrameMath.resolve(basisOf(0, 179.95), constants);
    const unchained = GeoSurfaceFrameMath.resolve(basisOf(0, -179.95), constants);
    const chained = GeoSurfaceFrameMath.resolve(basisOf(0, -179.95), constants, first.flatWorldX);

    expectClose(Math.abs(unchained.flatWorldX - first.flatWorldX), constants.globeMapSize, constants.globeMapSize * 0.05);
    expect(Math.abs(chained.flatWorldX - first.flatWorldX)).toBeLessThan(constants.globeMapSize * 0.01);
  });
});
