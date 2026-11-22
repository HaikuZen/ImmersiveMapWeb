// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { type Mat4, Matrix, mat4Multiply, mat4TransformVec4, mat4Transpose } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import type { GlobeRenderState } from "../presentation/resolved-presentation-state.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import { RenderCamera } from "./render-camera.ts";
import { RenderCameraPoseResolver } from "./render-camera-pose-resolver.ts";
import { ZoomAnchorMath } from "./zoom-anchor-math.ts";

const viewport: Vec2 = [800, 600];

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function makeCameraState(latitude: number, longitude: number, zoom: number, bearing = 0): ImmersiveMapCameraState {
  const center = ImmersiveMapProjection.worldMercator((latitude * Math.PI) / 180.0, (longitude * Math.PI) / 180.0);
  return ImmersiveMapCameraState.make(center, zoom, bearing, 0);
}

function compensatedCenter(stateBefore: ImmersiveMapCameraState, stateAfter: ImmersiveMapCameraState, anchorPoint: Vec2, anchorFactor = 1.0): Vec2 {
  return ZoomAnchorMath.compensatedCenterWorldMercator({
    anchorPoint,
    viewportSize: viewport,
    centerWorldMercator: stateBefore.centerWorldMercator,
    zoomBefore: stateBefore.zoom,
    zoomAfter: stateAfter.zoom,
    bearing: stateBefore.bearing,
    transitionBefore: PresentationStateResolver.resolve(stateBefore, defaultPresentationSettings).presentationState.transition,
    transitionAfter: PresentationStateResolver.resolve(stateAfter, defaultPresentationSettings).presentationState.transition,
    globeRadiusScale: defaultPresentationSettings.globeRadiusScale,
    anchorFactor,
  });
}

/** Spherical position of a globe point at transition 0, built independently of the projection code. */
function sphereWorldPosition(latitudeRadians: number, longitudeRadians: number, globeRenderState: GlobeRenderState): Vec3 {
  const radius = globeRenderState.renderRadius;
  const panLatitude = globeRenderState.pan[1] * ImmersiveMapProjection.maxMercatorLatitude;
  const panLongitude = globeRenderState.pan[0] * Math.PI;
  const xRotation = Matrix.rotationMatrixX(new Float64Array(16), -panLatitude);
  const yRotation = Matrix.rotationMatrixY(new Float64Array(16), -panLongitude);
  const rotation: Mat4 = mat4Multiply(new Float64Array(16), yRotation, xRotation);
  const cosLatitude = Math.cos(latitudeRadians);
  const unit: Vec3 = [cosLatitude * Math.sin(longitudeRadians), Math.sin(latitudeRadians), cosLatitude * Math.cos(longitudeRadians)];
  const rotated = mat4TransformVec4(mat4Transpose(rotation, rotation), [unit[0] * radius, unit[1] * radius, unit[2] * radius, 1]);
  return [rotated[0], rotated[1], rotated[2] - radius];
}

/**
 * Projects a geo point into view coordinates (top-left origin) with the same
 * formulas as the renderer: the flat world or the globe sphere (transition 0)
 * and the RenderCamera perspective camera.
 */
function projectToScreen(latitude: number, longitude: number, cameraState: ImmersiveMapCameraState): Vec2 | null {
  const presentation = PresentationStateResolver.resolve(cameraState, defaultPresentationSettings);
  const camera = new RenderCamera();
  camera.recalculateProjection(viewport[0] / viewport[1]);
  new RenderCameraPoseResolver().updateIfNeeded(camera, cameraState, presentation.presentationState.transition);
  const latitudeRadians = (latitude * Math.PI) / 180.0;
  const longitudeRadians = (longitude * Math.PI) / 180.0;
  let worldPosition: Vec3;
  if (presentation.screenSpaceProjectionMode === "flat") {
    const flat = ImmersiveMapProjection.flatWorldPosition(
      latitudeRadians,
      longitudeRadians,
      presentation.flatRenderState.pan,
      presentation.flatRenderState.renderMapSize,
    );
    worldPosition = [flat[0], flat[1], 0];
  } else {
    if (presentation.presentationState.transition !== 0) {
      // The sphere-to-plane morph is not reproduced in the test projection.
      return null;
    }
    worldPosition = sphereWorldPosition(latitudeRadians, longitudeRadians, presentation.globeRenderState);
  }
  const clip = mat4TransformVec4(camera.cameraMatrix!, [worldPosition[0], worldPosition[1], worldPosition[2], 1]);
  if (!(clip[3] > 0)) {
    return null;
  }
  return [((clip[0] / clip[3]) * 0.5 + 0.5) * viewport[0], (1.0 - ((clip[1] / clip[3]) * 0.5 + 0.5)) * viewport[1]];
}

/**
 * Invariant for the flat phase: a geo point projected into the anchor before
 * the zoom projects to the same screen point after the anchored zoom.
 */
function assertFlatAnchorInvariant(zoomBefore: number, zoomAfter: number, bearing: number): void {
  const stateBefore = makeCameraState(55.7558, 37.6173, zoomBefore, bearing);
  let stateAfter: ImmersiveMapCameraState = { ...stateBefore, zoom: zoomAfter };
  const anchor = projectToScreen(55.7625, 37.63, stateBefore)!;
  stateAfter = { ...stateAfter, centerWorldMercator: compensatedCenter(stateBefore, stateAfter, anchor) };
  const projected = projectToScreen(55.7625, 37.63, stateAfter)!;
  expectClose(projected[0], anchor[0], 0.5);
  expectClose(projected[1], anchor[1], 0.5);
}

/**
 * Anchored zoom must keep the world point under the cursor in place: the
 * invariant is checked with the full render projection (the presentation
 * resolver and the render camera) before and after the center compensation.
 */
describe("ZoomAnchorMath", () => {
  test("a flat anchored zoom keeps the point under the cursor", () => {
    assertFlatAnchorInvariant(15.3, 15.9, 0);
  });

  test("a flat anchored zoom across an integer zoom boundary", () => {
    assertFlatAnchorInvariant(15.8, 16.4, 0);
  });

  test("a flat anchored zoom with a bearing", () => {
    assertFlatAnchorInvariant(15.3, 15.9, 0.7);
  });

  test("a flat anchored zoom out keeps the point under the cursor", () => {
    assertFlatAnchorInvariant(15.5, 14.8, 0);
  });

  test("a globe anchored zoom keeps the point near the cursor", () => {
    const stateBefore = makeCameraState(10.0, 20.0, 2.0);
    let stateAfter: ImmersiveMapCameraState = { ...stateBefore, zoom: 2.6 };
    // A point not far from the screen center: the sphere's linear
    // approximation is accurate only near the center.
    const anchor = projectToScreen(12.0, 23.0, stateBefore)!;
    stateAfter = { ...stateAfter, centerWorldMercator: compensatedCenter(stateBefore, stateAfter, anchor) };
    const projected = projectToScreen(12.0, 23.0, stateAfter)!;
    expectClose(projected[0], anchor[0], 4.0);
    expectClose(projected[1], anchor[1], 4.0);
  });

  test("an anchor factor of zero keeps the center", () => {
    const stateBefore = makeCameraState(55.75, 37.61, 15.0);
    const center = compensatedCenter(stateBefore, { ...stateBefore, zoom: 16.0 }, [600, 150], 0.0);
    expect(center).toEqual(stateBefore.centerWorldMercator);
  });

  test("an anchor at the center keeps the center", () => {
    const stateBefore = makeCameraState(55.75, 37.61, 15.0);
    const center = compensatedCenter(stateBefore, { ...stateBefore, zoom: 16.0 }, [viewport[0] * 0.5, viewport[1] * 0.5]);
    expect(center).toEqual(stateBefore.centerWorldMercator);
  });

  test("equal zooms keep the center", () => {
    const state = makeCameraState(55.75, 37.61, 20.0);
    expect(compensatedCenter(state, state, [600, 150])).toEqual(state.centerWorldMercator);
  });
});
