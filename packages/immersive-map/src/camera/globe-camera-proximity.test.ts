// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultCameraSettings } from "../configuration/camera-settings.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { GlobeUnrollMath } from "../globe/globe-unroll-math.ts";
import { mat4Identity } from "../math/matrix.ts";
import { length3, sub3, type Vec3 } from "../math/vec.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import { CameraStateController } from "./camera-state-controller.ts";
import { GlobeCameraProximity } from "./globe-camera-proximity.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import { RenderCamera } from "./render-camera.ts";
import { RenderCameraPoseResolver } from "./render-camera-pose-resolver.ts";
import { SurfaceScaleMath } from "./surface-scale-math.ts";

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

/**
 * The globe camera proximity: from the activation zoom up the render camera
 * moves in by the view centre's surface scale, so the frustum holds the same
 * number of tiles at every latitude and the globe shows the Mercator scale
 * of the plane. The pan compensation and the zoom anchor read the same
 * factor, and the surface scale curve is the one the unroll geometry
 * actually has.
 */
describe("GlobeCameraProximity", () => {
  const sixtyDegrees = (60.0 * Math.PI) / 180.0;
  const yOfLatitude = (latitude: number): number => (1.0 - ImmersiveMapProjection.yMercatorNormalized(latitude)) * 0.5;

  test("the move-in ramps in from the activation zoom", () => {
    const { activationZoom, activationSpan } = GlobeCameraProximity;
    expect(GlobeCameraProximity.activation(0)).toBe(0);
    expect(GlobeCameraProximity.activation(activationZoom)).toBe(0);
    expectClose(GlobeCameraProximity.activation(activationZoom + activationSpan / 2), 0.5, 1e-9);
    expect(GlobeCameraProximity.activation(activationZoom + activationSpan)).toBe(1);
    expect(GlobeCameraProximity.activation(16)).toBe(1);
    expect(activationZoom).toBe(3);
  });

  test("the factor is the surface scale once active", () => {
    expectClose(GlobeCameraProximity.distanceFactor(sixtyDegrees, 0, 5), 0.5, 1e-6, "At 60 degrees on the sphere the camera sits at half the distance");
    expectClose(GlobeCameraProximity.distanceFactor(0, 0, 5), 1, 1e-6, "The equator is the Mercator scale already");
    expectClose(GlobeCameraProximity.distanceFactor(sixtyDegrees, 1, 8), 1, 1e-6, "The plane needs no move-in");
    expectClose(GlobeCameraProximity.distanceFactor(sixtyDegrees, 0, 2), 1, 1e-6, "Below the activation zoom the camera stays where the zoom puts it");
    expectClose(GlobeCameraProximity.distanceFactor(sixtyDegrees, 0, 3.5), 0.75, 1e-6, "Half way through the ramp, half the move-in");
  });

  test("the Mercator limit bounds the move-in", () => {
    // The view centre never lies beyond the Mercator limit, so the factor
    // never falls below its cosine and the camera never reaches the surface
    // (the near plane is 0.01 of a unit camera distance).
    const limit = ImmersiveMapProjection.latitudeFromNormalizedWorldY(0);
    const factor = GlobeCameraProximity.distanceFactor(limit, 0, 10);
    expectClose(factor, Math.cos(ImmersiveMapProjection.maxMercatorLatitude), 1e-6);
    expect(factor * 0.5).toBeGreaterThan(0.01);
  });

  /**
   * The surface scale curve through the morph is the geometry's: the unroll
   * blends the azimuthal-equidistant chart with the inflating flat target,
   * and at the view centre that gives `cos + g^2 (1 - cos)`. Measured on the
   * CPU mirror of the geometry, for several latitudes and phases, as the
   * ratio of the surface distance to the Mercator distance between the
   * centre and a point just north of it.
   */
  test("the surface scale curve matches the unroll geometry", () => {
    for (const latitudeDegrees of [0.0, 40.0, 70.0, 80.0]) {
      for (const transition of [0, 0.2, 0.45, 0.7, 0.9, 1.0]) {
        const latitude = (latitudeDegrees * Math.PI) / 180;
        const cameraState = ImmersiveMapCameraState.make([0.5, yOfLatitude(latitude)], 6.5, 0, 0);
        const base = PresentationStateResolver.resolve(cameraState, defaultPresentationSettings, "spherical");
        const globe = { ...base.globeRenderState.globeUniform, transition: PresentationStateResolver.geometryTransition(transition) };
        const presentation: ResolvedPresentationState = {
          ...base,
          presentationState: { transition },
          renderSurfaceMode: "spherical",
          screenSpaceProjectionMode: "globe",
          globeRenderState: { ...base.globeRenderState, globeUniform: globe },
        };
        const constants = new GeoScreenProjectionFrameConstants(100, 100, { matrix: mat4Identity(), eye: [0, 0, 1] }, presentation);
        // Half a degree, symmetric about the centre: wide enough for the
        // Float32 mirror's acos near 1, narrow enough that the Mercator
        // stretch across it averages to the centre's.
        const deltaLatitude = (0.5 * Math.PI) / 180;
        const center = GeoProjectionBasis.fromRadians(latitude - deltaLatitude / 2, 0);
        const north = GeoProjectionBasis.fromRadians(latitude + deltaLatitude / 2, 0);
        const surfacePoint = (basis: GeoProjectionBasis): Vec3 => {
          const flat = constants.globeFlatWorldPosition(basis);
          return GlobeUnrollMath.worldPosition(constants.rotatedSphereWorldPosition(basis.sphereUnit), [flat[0], flat[1]], globe.transition, globe.radius);
        };
        const surfaceDistance = length3(sub3(surfacePoint(north), surfacePoint(center)));
        const mercatorDistance = (north.mercatorYNormalized - center.mercatorYNormalized) * 0.5 * 2.0 * Math.PI * globe.radius;
        const measured = surfaceDistance / mercatorDistance;
        const predicted = SurfaceScaleMath.surfaceScale(latitude, transition);
        expectClose(measured, predicted, 0.02, `latitude ${latitudeDegrees} transition ${transition}: measured ${measured}, predicted ${predicted}`);
      }
    }
  });

  test("the render camera moves in on the globe", () => {
    const camera = new RenderCamera();
    camera.recalculateProjection(1);
    const resolver = new RenderCameraPoseResolver();
    const state = ImmersiveMapCameraState.make([0.5, yOfLatitude(sixtyDegrees)], 5, 0, 0);
    resolver.updateIfNeeded(camera, state, 0);
    expectClose(length3(camera.eye), 0.5, 1e-5, "Zoom 5 at 60 degrees on the sphere: half the unit distance");
    // The same state on the plane (a forced surface): the phase alone
    // re-poses the camera.
    resolver.updateIfNeeded(camera, state, 1);
    expectClose(length3(camera.eye), 1, 1e-5);
    // Below the activation zoom the equatorial distance holds.
    resolver.requestUpdate();
    resolver.updateIfNeeded(camera, ImmersiveMapCameraState.make([0.5, yOfLatitude(sixtyDegrees)], 2, 0, 0), 0);
    expectClose(length3(camera.eye), 1, 1e-5);
  });

  test("the transition window no longer stretches with latitude", () => {
    const settings = defaultPresentationSettings;
    const zoom = settings.automaticTransitionStartZoom + settings.automaticTransitionSpan;
    const equator = ImmersiveMapCameraState.make([0.5, 0.5], zoom, 0, 0);
    const polar = ImmersiveMapCameraState.make([0.5, yOfLatitude((80 * Math.PI) / 180)], zoom, 0, 0);
    expect(PresentationStateResolver.resolve(equator, settings).presentationState.transition).toBe(1);
    expect(
      PresentationStateResolver.resolve(polar, settings).presentationState.transition,
      "One span above the start the morph is complete at every latitude",
    ).toBe(1);
  });

  test("the pan compensation vanishes once the camera moved in", () => {
    // At 60 degrees, zoom 8 on the sphere: the camera is at half distance, so
    // a swipe moves the same Mercator as on the plane and the vertical
    // compensation is 1. At zoom 2 (no move-in) it is the old 1 / cos = 2.
    const controller = new CameraStateController(defaultCameraSettings);
    const centerY = yOfLatitude(sixtyDegrees);
    const verticalMove = (zoom: number): number => {
      controller.setCameraState(ImmersiveMapCameraState.make([0.5, centerY], zoom, 0, 0));
      const before = controller.cameraState.centerWorldMercator[1];
      controller.pan(0, 10, 0);
      return (controller.cameraState.centerWorldMercator[1] - before) * 2.0 ** zoom;
    };
    const equatorController = new CameraStateController(defaultCameraSettings);
    equatorController.setCameraState(ImmersiveMapCameraState.make([0.5, 0.5], 8, 0, 0));
    const equatorBefore = equatorController.cameraState.centerWorldMercator[1];
    equatorController.pan(0, 10, 0);
    const equatorMove = (equatorController.cameraState.centerWorldMercator[1] - equatorBefore) * 2.0 ** 8;
    expectClose(verticalMove(8), equatorMove, Math.abs(equatorMove) * 1e-6);
    expectClose(verticalMove(2), equatorMove * 2, Math.abs(equatorMove) * 1e-6);
  });
});
