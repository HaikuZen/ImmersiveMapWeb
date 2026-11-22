// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../camera/render-camera-pose-resolver.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { mat4TransformVec4 } from "../math/matrix.ts";
import { type Vec2, type Vec3, vec2 } from "../math/vec.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import { geoCoordinate } from "./geo-coordinate.ts";
import { GeoProjectionBasis } from "./geo-projection-basis.ts";
import { GeoScreenProjectionFrameConstants, GeoScreenProjectionMath } from "./geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

const drawWidth = 800;
const drawHeight = 600;

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

interface ProjectionEnvironment {
  readonly presentation: ResolvedPresentationState;
  readonly constants: GeoScreenProjectionFrameConstants;
}

/** The camera assembled as the renderer assembles it (RenderCamera and its pose resolver). */
function makeEnvironment(cameraState: ImmersiveMapCameraState): ProjectionEnvironment {
  const presentation = PresentationStateResolver.resolve(cameraState, defaultPresentationSettings);
  const camera = new RenderCamera();
  camera.recalculateProjection(drawWidth / drawHeight);
  new RenderCameraPoseResolver().updateIfNeeded(camera, cameraState, presentation.presentationState.transition);
  const matrix = camera.cameraMatrix!.slice();
  return {
    presentation,
    constants: new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, { matrix, eye: camera.eye }, presentation),
  };
}

function makeCameraState(latitude: number, longitude: number, zoom: number, bearing = 0, pitch = 0): ImmersiveMapCameraState {
  const center = ImmersiveMapProjection.worldMercator((latitude * Math.PI) / 180.0, (longitude * Math.PI) / 180.0);
  return ImmersiveMapCameraState.make(center, zoom, bearing, pitch);
}

/** Screen point of a world position through the same camera as the constants (drawable px, origin bottom-left). */
function screenPoint(worldPosition: Vec3, constants: GeoScreenProjectionFrameConstants): Vec2 | null {
  const clip = mat4TransformVec4(constants.cameraUniform.matrix, [worldPosition[0], worldPosition[1], worldPosition[2], 1.0]);
  if (!(clip[3] > 0)) {
    return null;
  }
  return [((clip[0] / clip[3]) * 0.5 + 0.5) * constants.viewport[0], ((clip[1] / clip[3]) * 0.5 + 0.5) * constants.viewport[1]];
}

const basisOf = (latitude: number, longitude: number): GeoProjectionBasis => GeoProjectionBasis.fromCoordinate(geoCoordinate(latitude, longitude));

/**
 * GeoScreenProjectionMath must project a coordinate with the same formulas as
 * the renderer's vertex path: flat world, globe sphere, the unroll, and the
 * soft horizon.
 */
describe("GeoScreenProjectionMath", () => {
  // Flat

  test("the flat center projects to the viewport center", () => {
    const environment = makeEnvironment(makeCameraState(55.75, 37.61, 15.0));
    expect(environment.constants.mode).toBe("flat");
    const point = GeoScreenProjectionMath.project(basisOf(55.75, 37.61), environment.constants);
    expect(point.visible).not.toBe(0);
    expect(point.visibilityAlpha).toBe(1.0);
    expectClose(point.positionX, drawWidth * 0.5, 0.5);
    expectClose(point.positionY, drawHeight * 0.5, 0.5);
  });

  test("a flat offset matches ImmersiveMapProjection.flatWorldPosition", () => {
    const environment = makeEnvironment(makeCameraState(40.0, -73.9, 14.2));
    expect(environment.constants.mode).toBe("flat");
    const point = GeoScreenProjectionMath.project(basisOf(40.02, -73.85), environment.constants);
    const flatWorld = ImmersiveMapProjection.flatWorldPosition(
      (40.02 * Math.PI) / 180.0,
      (-73.85 * Math.PI) / 180.0,
      environment.presentation.flatRenderState.pan,
      environment.presentation.flatRenderState.renderMapSize,
    );
    const expected = screenPoint([flatWorld[0], flatWorld[1], 0.0], environment.constants)!;
    expect(point.visible).not.toBe(0);
    expectClose(point.positionX, expected[0], 0.01);
    expectClose(point.positionY, expected[1], 0.01);
  });

  /**
   * A marker on the other side of the antimeridian from the camera must, via
   * the wrap, end up near the screen center rather than across the world.
   */
  test("the flat antimeridian wrap keeps a marker near the camera", () => {
    const environment = makeEnvironment(makeCameraState(0.0, 179.9, 10.0));
    expect(environment.constants.mode).toBe("flat");
    const point = GeoScreenProjectionMath.project(basisOf(0.0, -179.9), environment.constants);
    expect(point.visible).not.toBe(0);
    expect(point.positionX).toBeGreaterThan(drawWidth * 0.5);
    expect(point.positionX).toBeLessThan(drawWidth);
    expectClose(point.positionY, drawHeight * 0.5, 0.5);

    // The equivalent "unwrapped" longitude must yield the same point.
    const unwrapped = GeoScreenProjectionMath.project(basisOf(0.0, 180.1), environment.constants);
    expect(unwrapped.visible).not.toBe(0);
    expectClose(point.positionX, unwrapped.positionX, 0.01);
    expectClose(point.positionY, unwrapped.positionY, 0.01);
  });

  /** A plane point far behind the tilted camera yields clip.w <= 0 and must be marked invisible. */
  test("a flat point far behind a tilted camera is invisible", () => {
    const environment = makeEnvironment(makeCameraState(0.0, 0.0, 16.0, 0, 1.2));
    expect(environment.constants.mode).toBe("flat");
    let foundInvisible = false;
    for (let latitude = 1.0; latitude <= 85.0; latitude += 1.0) {
      for (const signedLatitude of [latitude, -latitude]) {
        const point = GeoScreenProjectionMath.project(basisOf(signedLatitude, 0.0), environment.constants);
        if (point.visible === 0) {
          foundInvisible = true;
          expect(point.visibilityAlpha).toBe(0.0);
        }
      }
    }
    expect(foundInvisible, "Expected at least one point behind the camera with clip.w <= 0").toBe(true);
  });

  test("a projection into a reused output allocates nothing new", () => {
    const environment = makeEnvironment(makeCameraState(55.75, 37.61, 15.0));
    const out = GeoScreenProjectionMath.project(basisOf(55.75, 37.61), environment.constants);
    const again = GeoScreenProjectionMath.project(basisOf(55.76, 37.62), environment.constants, out);
    expect(again).toBe(out);
  });

  // Globe

  test("a globe front point is visible with full alpha at the viewport center", () => {
    const environment = makeEnvironment(makeCameraState(10.0, 20.0, 1.0));
    expect(environment.constants.mode).toBe("globe");
    expect(environment.constants.globe.transition).toBe(0.0);
    const point = GeoScreenProjectionMath.project(basisOf(10.0, 20.0), environment.constants);
    expect(point.visible).not.toBe(0);
    expect(point.visibilityAlpha).toBe(1.0);
    expectClose(point.positionX, drawWidth * 0.5, 0.5);
    expectClose(point.positionY, drawHeight * 0.5, 0.5);
  });

  test("a globe back point is hidden with zero alpha", () => {
    const environment = makeEnvironment(makeCameraState(0.0, 0.0, 1.0));
    expect(environment.constants.mode).toBe("globe");
    const point = GeoScreenProjectionMath.project(basisOf(-10.0, -160.0), environment.constants);
    expect(point.visible).toBe(0);
    expect(point.visibilityAlpha).toBe(0.0);
  });

  /** Within the horizon band, alpha must pass through intermediate values rather than switching as a step. */
  test("the globe horizon fade band produces a partial alpha", () => {
    const environment = makeEnvironment(makeCameraState(0.0, 0.0, 1.0));
    expect(environment.constants.mode).toBe("globe");
    let foundPartialAlpha = false;
    for (let longitude = 30.0; longitude <= 150.0; longitude += 0.25) {
      const point = GeoScreenProjectionMath.project(basisOf(0.0, longitude), environment.constants);
      if (point.visible !== 0 && point.visibilityAlpha > 0.0 && point.visibilityAlpha < 1.0) {
        foundPartialAlpha = true;
        break;
      }
    }
    expect(foundPartialAlpha, "Expected a longitude with partial alpha inside the horizon band").toBe(true);
  });

  /** Mid-morph, a point must ride the unroll rather than a uniform lerp of the global transition. */
  test("mid-morph applies the unroll instead of a uniform lerp", () => {
    const zoom = defaultPresentationSettings.automaticTransitionStartZoom + defaultPresentationSettings.automaticTransitionSpan * 0.45;
    const environment = makeEnvironment(makeCameraState(0.0, 0.0, zoom));
    expect(environment.constants.mode).toBe("globe");
    const transition = environment.constants.globe.transition;
    expect(transition).toBeGreaterThan(0.0);
    expect(transition).toBeLessThan(0.95);

    const basis = basisOf(25.0, 35.0);
    const point = GeoScreenProjectionMath.project(basis, environment.constants);
    expect(point.visible).not.toBe(0);

    const sphere = environment.constants.rotatedSphereWorldPosition(basis.sphereUnit);
    const flat = environment.constants.globeFlatWorldPosition(basis);

    // An independent copy of the unroll: a straight chart line between the
    // point's azimuthal-equidistant image and its Mercator image, wrapped onto
    // the growing sphere, not the straight lerp of the two world positions.
    const radius = environment.constants.globe.radius;
    const curvature = (1.0 - transition) / radius;
    const fromCenter: Vec3 = [sphere[0], sphere[1], sphere[2] + radius];
    const arcSphere = radius * Math.acos(Math.min(Math.max(fromCenter[2] / radius, -1), 1));
    const dirLength = Math.hypot(fromCenter[0], fromCenter[1]);
    const dir = vec2(fromCenter[0] / dirLength, fromCenter[1] / dirLength);
    const chartX = dir[0] * arcSphere + (flat[0] - dir[0] * arcSphere) * transition;
    const chartY = dir[1] * arcSphere + (flat[1] - dir[1] * arcSphere) * transition;
    const arc = Math.hypot(chartX, chartY);
    const angle = arc * curvature;
    const unrolled: Vec3 = [
      ((chartX / arc) * Math.sin(angle)) / curvature,
      ((chartY / arc) * Math.sin(angle)) / curvature,
      (Math.cos(angle) - 1.0) / curvature,
    ];
    const lerp: Vec3 = [
      sphere[0] + (flat[0] - sphere[0]) * transition,
      sphere[1] + (flat[1] - sphere[1]) * transition,
      sphere[2] + (flat[2] - sphere[2]) * transition,
    ];
    expect(
      Math.hypot(unrolled[0] - lerp[0], unrolled[1] - lerp[1], unrolled[2] - lerp[2]),
      "Far from the centre the unroll must differ from a uniform lerp",
    ).toBeGreaterThan(1e-2);

    const expected = screenPoint(unrolled, environment.constants)!;
    expectClose(point.positionX, expected[0], 0.01);
    expectClose(point.positionY, expected[1], 0.01);

    const uniformExpected = screenPoint(lerp, environment.constants)!;
    expect(
      Math.hypot(point.positionX - uniformExpected[0], point.positionY - uniformExpected[1]),
      "A uniform lerp must land on a noticeably different screen point",
    ).toBeGreaterThan(1.0);
  });

  /**
   * Regression of a screenshot artifact: mid-morph (medium zoom), a marker on
   * the far side of the sphere (Fiji with the camera over Voronezh) must not
   * leak through: the point is still on the spherical far side.
   */
  test("mid-morph keeps a far side marker hidden", () => {
    const zoom = defaultPresentationSettings.automaticTransitionStartZoom + defaultPresentationSettings.automaticTransitionSpan * 0.37;
    const environment = makeEnvironment(makeCameraState(51.209, 39.205, zoom));
    expect(environment.constants.mode).toBe("globe");
    expect(environment.constants.globe.transition).toBeGreaterThan(0.0);
    expect(environment.constants.globe.transition).toBeLessThan(0.95);
    const point = GeoScreenProjectionMath.project(basisOf(-17.7134, 179.2), environment.constants);
    expect(point.visible, "A point on the still spherical far side must be hidden").toBe(0);
    expect(point.visibilityAlpha).toBe(0.0);
  });

  /**
   * Regression of "fly-through" markers: in the morph's tail a far point's
   * position has left the sphere for its flat location and can cross the
   * viewport on the way. A point beyond the sphere's horizon must stay hidden
   * throughout the morph: London with the camera over Tokyo must not flash
   * over empty ocean.
   */
  test("a late morph keeps a far marker hidden during the unfurl transit", () => {
    const zoom = defaultPresentationSettings.automaticTransitionStartZoom + defaultPresentationSettings.automaticTransitionSpan * 0.79;
    const environment = makeEnvironment(makeCameraState(35.6595, 139.7005, zoom, 0, 1.28));
    expect(environment.constants.mode).toBe("globe");
    expect(environment.constants.globe.transition).toBeGreaterThan(0.8);
    expect(environment.constants.globe.transition).toBeLessThan(0.95);
    const point = GeoScreenProjectionMath.project(basisOf(51.5072, -0.1276), environment.constants);
    expect(point.visible).toBe(0);
    expect(point.visibilityAlpha).toBe(0.0);
  });

  /** With the morph nearly complete (geometry already flat, surface still globe) the former far side is legitimately visible. */
  test("a near-flat morph shows a former far side marker", () => {
    const zoom = defaultPresentationSettings.automaticTransitionStartZoom + defaultPresentationSettings.automaticTransitionSpan * 0.92;
    const environment = makeEnvironment(makeCameraState(0.0, 39.205, zoom));
    expect(environment.constants.mode).toBe("globe");
    expect(environment.constants.globe.transition).toBeGreaterThanOrEqual(0.95);
    const point = GeoScreenProjectionMath.project(basisOf(-17.7134, 179.2), environment.constants);
    expect(point.visible).not.toBe(0);
    expect(point.visibilityAlpha).toBe(1.0);
  });
});
