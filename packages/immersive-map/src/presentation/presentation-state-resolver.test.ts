// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { type CameraPresentationSettings, defaultCameraPresentationSettings } from "./camera-presentation-settings.ts";
import { MapPresentationStateController } from "./map-presentation-state-controller.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

const globeDisabled: CameraPresentationSettings = {
  ...defaultCameraPresentationSettings,
  presentation: { ...defaultCameraPresentationSettings.presentation, isGlobeEnabled: false },
};

const atCenter = (zoom: number): ImmersiveMapCameraState => ImmersiveMapCameraState.make([0.5, 0.5], zoom, 0, 0);

describe("PresentationStateResolver", () => {
  test("the automatic presentation uses the spherical surface at a low zoom", () => {
    const resolved = new MapPresentationStateController(defaultCameraPresentationSettings).resolve(atCenter(5.0));
    expect(resolved.renderSurfaceMode).toBe("spherical");
    expect(resolved.screenSpaceProjectionMode).toBe("globe");
    expect(resolved.presentationState.transition).toBe(0.0);
  });

  test("the automatic presentation uses the flat surface at a high zoom", () => {
    const resolved = new MapPresentationStateController(defaultCameraPresentationSettings).resolve(atCenter(7.0));
    expect(resolved.renderSurfaceMode).toBe("flat");
    expect(resolved.screenSpaceProjectionMode).toBe("flat");
    expect(resolved.presentationState.transition).toBe(1.0);
  });

  /**
   * With the globe off the map is the plane at every zoom: a completed
   * transition and the flat surface where the default would be a sphere.
   */
  test("a disabled globe is the flat surface at every zoom", () => {
    const resolver = new MapPresentationStateController(globeDisabled);
    for (const zoom of [0.0, 3.0, 5.9, 7.0]) {
      const resolved = resolver.resolve(atCenter(zoom));
      expect(resolved.renderSurfaceMode, `at zoom ${zoom}`).toBe("flat");
      expect(resolved.presentationState.transition, `at zoom ${zoom}`).toBe(1.0);
    }
  });

  /**
   * The debug panel's switch still shows the sphere on a globe-disabled map,
   * and switching again returns to the plane the setting asks for.
   */
  test("the debug switch still forces the sphere with the globe disabled", () => {
    const resolver = new MapPresentationStateController(globeDisabled);
    const cameraState = atCenter(2.0);
    expect(resolver.resolve(cameraState).renderSurfaceMode).toBe("flat");
    resolver.switchRenderSurfaceMode(cameraState);
    expect(resolver.resolve(cameraState).renderSurfaceMode).toBe("spherical");
    resolver.switchRenderSurfaceMode(cameraState);
    expect(resolver.resolve(cameraState).renderSurfaceMode).toBe("flat");
  });

  test("the transition window is the same at every latitude", () => {
    const resolver = new MapPresentationStateController(defaultCameraPresentationSettings);
    const settings = defaultPresentationSettings;
    const polarCenter = ImmersiveMapProjection.worldMercator((83.0 * Math.PI) / 180.0, 0);
    const equatorCenter = ImmersiveMapProjection.worldMercator(0, 0);
    // The camera's globe proximity absorbs the Mercator inflation
    // (GlobeCameraProximity), so the window is the settings' span at the
    // pole as at the equator.
    for (const fraction of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      const zoom = settings.automaticTransitionStartZoom + settings.automaticTransitionSpan * fraction;
      const polar = resolver.resolve(ImmersiveMapCameraState.make(polarCenter, zoom, 0, 0));
      const equator = resolver.resolve(ImmersiveMapCameraState.make(equatorCenter, zoom, 0, 0));
      expectClose(polar.presentationState.transition, equator.presentationState.transition, 1e-6);
      expectClose(polar.presentationState.transition, fraction, 1e-6);
    }
  });

  test("the transition grows monotonically with the zoom near the pole", () => {
    const resolver = new MapPresentationStateController(defaultCameraPresentationSettings);
    const settings = defaultPresentationSettings;
    const polarCenter = ImmersiveMapProjection.worldMercator((83.0 * Math.PI) / 180.0, 0);
    const transitions = [0.1, 0.35, 0.6, 0.85].map((fraction) => {
      const zoom = settings.automaticTransitionStartZoom + settings.automaticTransitionSpan * fraction;
      return resolver.resolve(ImmersiveMapCameraState.make(polarCenter, zoom, 0, 0)).presentationState.transition;
    });
    expect(transitions).toEqual([...transitions].sort((a, b) => a - b));
    expect(new Set(transitions).size, "The transition steps must not collapse into each other").toBe(transitions.length);
  });

  test("the morph geometry completes before the surface swap", () => {
    const lateMorph = new MapPresentationStateController(defaultCameraPresentationSettings).resolve(atCenter(6.92));
    expect(lateMorph.renderSurfaceMode).toBe("spherical");
    expectClose(lateMorph.presentationState.transition, 0.92, 1e-3);
    expect(lateMorph.globeRenderState.globeUniform.transition).toBe(1.0);
  });

  test("the morph geometry runs slightly ahead of the semantic transition", () => {
    const midMorph = new MapPresentationStateController(defaultCameraPresentationSettings).resolve(atCenter(6.45));
    expectClose(midMorph.presentationState.transition, 0.45, 1e-3);
    expectClose(midMorph.globeRenderState.globeUniform.transition, 0.5, 1e-3);
  });

  test("the surface switch forces the opposite surface and a second switch returns to automatic", () => {
    const resolver = new MapPresentationStateController(defaultCameraPresentationSettings);
    const highZoom = atCenter(7.0);

    resolver.switchRenderSurfaceMode(highZoom);
    const forced = resolver.resolve(highZoom);
    expect(forced.renderSurfaceMode).toBe("spherical");
    expect(forced.presentationState.transition).toBe(0.0);

    resolver.switchRenderSurfaceMode(highZoom);
    const automatic = resolver.resolve(highZoom);
    expect(automatic.renderSurfaceMode).toBe("flat");
    expect(automatic.presentationState.transition).toBe(1.0);
  });
});
