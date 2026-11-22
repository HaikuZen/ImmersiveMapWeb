// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `SceneModelAnchorMathTests`: SceneModelAnchorMath must
// place a model anchor with the same formulas as GeoScreenProjectionMath (the
// CPU mirror of the globe shaders): flat world, globe sphere, and the unroll.
// The camera is assembled as in the renderer.

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../camera/render-camera-pose-resolver.ts";
import { defaultPresentationSettings } from "../configuration/presentation-settings.ts";
import { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import { GeoScreenProjectionFrameConstants, GeoScreenProjectionMath } from "../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { GlobeUnrollMath } from "../globe/globe-unroll-math.ts";
import { type Mat4, mat4TransformVec4 } from "../math/matrix.ts";
import { cross3, dot3, length3, normalize3, sub3, type Vec2, type Vec3 } from "../math/vec.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import { ImmersiveMapSceneModelSource } from "./immersive-map-scene-model.ts";
import { SceneModelAnimationMath } from "./presentation/scene-model-animation-math.ts";
import type { PresentedSceneModel } from "./presentation/scene-model-presentation-state-store.ts";
import { SceneModelAnchorMath } from "./scene-model-anchor-math.ts";
import { makeSceneModelBounds } from "./scene-model-bounds.ts";

const drawWidth = 800;
const drawHeight = 600;
const settings = defaultPresentationSettings;
const unitBounds = makeSceneModelBounds([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);

interface Environment {
  readonly presentation: ResolvedPresentationState;
  readonly constants: GeoScreenProjectionFrameConstants;
}

function makeEnvironment(latitude: number, longitude: number, zoom: number): Environment {
  const center = ImmersiveMapProjection.worldMercator((latitude * Math.PI) / 180, (longitude * Math.PI) / 180);
  const cameraState = ImmersiveMapCameraState.make(center, zoom, 0, 0);
  const presentation = PresentationStateResolver.resolve(cameraState, settings);
  const camera = new RenderCamera();
  camera.recalculateProjection(drawWidth / drawHeight);
  new RenderCameraPoseResolver().updateIfNeeded(camera, cameraState, presentation.presentationState.transition);
  return { presentation, constants: new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, { matrix: camera.cameraMatrix!.slice(), eye: camera.eye }, presentation) };
}

function makePresented(
  latitude: number,
  longitude: number,
  values: { altitudeMeters?: number; headingDegrees?: number; pitchDegrees?: number; rollDegrees?: number; scale?: number; fitDiameterMeters?: number | null } = {},
): PresentedSceneModel {
  const coordinate = { latitude, longitude };
  return {
    id: 1,
    source: ImmersiveMapSceneModelSource.make("models/model.glb"),
    fitDiameterMeters: values.fitDiameterMeters ?? null,
    coordinate,
    projectionBasis: GeoProjectionBasis.fromCoordinate(coordinate),
    orientation: SceneModelAnimationMath.orientationQuaternion(values.headingDegrees ?? 0, values.pitchDegrees ?? 0, values.rollDegrees ?? 0),
    scale: values.scale ?? 1,
    altitudeMeters: values.altitudeMeters ?? 0,
    cutsIntoGround: false,
  };
}

function translation(matrix: Mat4): Vec3 {
  return [matrix[12]!, matrix[13]!, matrix[14]!];
}

function column(matrix: Mat4, index: number): Vec3 {
  return [matrix[index * 4]!, matrix[index * 4 + 1]!, matrix[index * 4 + 2]!];
}

/** The linear part applied to a direction. */
function applyLinear(matrix: Mat4, v: Vec3): Vec3 {
  const result = mat4TransformVec4(matrix, [v[0], v[1], v[2], 0]);
  return [result[0], result[1], result[2]];
}

function screenPoint(worldPosition: Vec3, constants: GeoScreenProjectionFrameConstants): Vec2 | null {
  const clip = mat4TransformVec4(constants.cameraUniform.matrix, [worldPosition[0], worldPosition[1], worldPosition[2], 1]);
  if (!(clip[3] > 0)) return null;
  return [((clip[0] / clip[3]) * 0.5 + 0.5) * constants.viewport[0], ((clip[1] / clip[3]) * 0.5 + 0.5) * constants.viewport[1]];
}

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function expectDirection(actual: Vec3, expected: Vec3): void {
  for (let axis = 0; axis < 3; axis++) expectClose(actual[axis]!, expected[axis]!, 1e-4);
}

describe("SceneModelAnchorMath", () => {
  // Position equivalence with the geo projector

  test("a flat anchor matches the geo projector", () => {
    const { constants } = makeEnvironment(55.75, 37.61, 15);
    expect(constants.mode).toBe("flat");
    for (const [latitude, longitude] of [
      [55.75, 37.61],
      [55.79, 37.55],
      [55.7, 37.7],
    ] as const) {
      const presented = makePresented(latitude, longitude);
      const anchor = SceneModelAnchorMath.resolveAnchor(presented, unitBounds, constants);
      const projected = GeoScreenProjectionMath.project(presented.projectionBasis, constants);
      const anchorScreen = screenPoint(translation(anchor.modelMatrix), constants)!;
      expect(projected.visible).not.toBe(0);
      expect(anchor.passesHorizonGate).toBe(true);
      expectClose(anchorScreen[0], projected.positionX, 0.01);
      expectClose(anchorScreen[1], projected.positionY, 0.01);
    }
  });

  test("a globe anchor matches the geo projector at transition zero", () => {
    const { constants } = makeEnvironment(10, 20, 1);
    expect(constants.mode).toBe("globe");
    expect(constants.globe.transition).toBe(0);
    for (const [latitude, longitude] of [
      [10, 20],
      [14, 26],
      [-3, 12],
    ] as const) {
      const presented = makePresented(latitude, longitude);
      const anchor = SceneModelAnchorMath.resolveAnchor(presented, unitBounds, constants);
      const projected = GeoScreenProjectionMath.project(presented.projectionBasis, constants);
      const anchorScreen = screenPoint(translation(anchor.modelMatrix), constants)!;
      expect(projected.visible).not.toBe(0);
      expect(anchor.passesHorizonGate).toBe(true);
      expectClose(anchorScreen[0], projected.positionX, 0.01);
      expectClose(anchorScreen[1], projected.positionY, 0.01);
    }
  });

  test("a mid-morph anchor rides the unroll", () => {
    const { constants } = makeEnvironment(0, 0, settings.automaticTransitionStartZoom + settings.automaticTransitionSpan * 0.45);
    expect(constants.mode).toBe("globe");
    const transition = constants.globe.transition;
    expect(transition).toBeGreaterThan(0);
    expect(transition).toBeLessThan(0.95);

    const presented = makePresented(25, 35);
    const anchor = SceneModelAnchorMath.resolveAnchor(presented, unitBounds, constants);
    const basis = presented.projectionBasis;
    const sphere = constants.rotatedSphereWorldPosition(basis.sphereUnit);
    const flat = constants.globeFlatWorldPosition(basis);
    const wave = GlobeUnrollMath.worldPosition(sphere, [flat[0], flat[1]], transition, constants.globe.radius);
    const anchorScreen = screenPoint(translation(anchor.modelMatrix), constants)!;
    const expected = screenPoint(wave, constants)!;
    expectClose(anchorScreen[0], expected[0], 0.01);
    expectClose(anchorScreen[1], expected[1], 0.01);
  });

  // Tangent frame

  test("the tangent frame stays orthonormal, uniform and right-handed through the morph", () => {
    const zooms = [
      1,
      settings.automaticTransitionStartZoom + settings.automaticTransitionSpan * 0.3,
      settings.automaticTransitionStartZoom + settings.automaticTransitionSpan * 0.7,
      15,
    ];
    for (const zoom of zooms) {
      const { constants } = makeEnvironment(45, 10, zoom);
      for (const [latitude, longitude] of [
        [0, 0],
        [60, 170],
        [-45, -179.9],
        [80, 10],
      ] as const) {
        const anchor = SceneModelAnchorMath.resolveAnchor(makePresented(latitude, longitude, { headingDegrees: 33, pitchDegrees: 12, rollDegrees: -7 }), unitBounds, constants);
        const [x, y, z] = [column(anchor.modelMatrix, 0), column(anchor.modelMatrix, 1), column(anchor.modelMatrix, 2)];
        const [ax, ay, az] = [normalize3(x), normalize3(y), normalize3(z)];
        expectClose(dot3(ax, ay), 0, 1e-3);
        expectClose(dot3(ay, az), 0, 1e-3);
        expectClose(dot3(ax, az), 0, 1e-3);
        // Uniform scale: all columns share one length.
        expectClose(length3(y) / length3(x), 1, 1e-3);
        expectClose(length3(z) / length3(x), 1, 1e-3);
        // Right-handed: no mirroring anywhere in the composition.
        expect(dot3(cross3(ax, ay), az)).toBeGreaterThan(0.5);
      }
    }
  });

  test("in flat mode with identity orientation the basis is the Y-up conversion alone", () => {
    const { constants } = makeEnvironment(48.85, 2.35, 15);
    expect(constants.mode).toBe("flat");
    const anchor = SceneModelAnchorMath.resolveAnchor(makePresented(48.85, 2.35), unitBounds, constants);
    // Asset +X stays east, asset +Y becomes world up, asset +Z faces south.
    expectDirection(normalize3(column(anchor.modelMatrix, 0)), [1, 0, 0]);
    expectDirection(normalize3(column(anchor.modelMatrix, 1)), [0, 0, 1]);
    expectDirection(normalize3(column(anchor.modelMatrix, 2)), [0, -1, 0]);
  });

  test("heading turns the model's forward toward east", () => {
    const { constants } = makeEnvironment(0, 0, 15);
    expect(constants.mode).toBe("flat");
    // Asset -Z faces north at heading 0, and heading 90 (clockwise) turns it east.
    const anchor = SceneModelAnchorMath.resolveAnchor(makePresented(0, 0, { headingDegrees: 90 }), unitBounds, constants);
    expectDirection(normalize3(applyLinear(anchor.modelMatrix, [0, 0, -1])), [1, 0, 0]);
  });

  // Meter scale, altitude, fit

  test("the flat meter scale matches the world units per meter", () => {
    const latitude = 60;
    const { constants, presentation } = makeEnvironment(latitude, 30, 15);
    expect(constants.mode).toBe("flat");
    const anchor = SceneModelAnchorMath.resolveAnchor(makePresented(latitude, 30), unitBounds, constants);
    const expected = ImmersiveMapProjection.worldUnitsPerMeter((latitude * Math.PI) / 180, presentation.flatRenderState.renderMapSize);
    expectClose(length3(column(anchor.modelMatrix, 0)) / expected, 1, 1e-3);
  });

  test("the globe meter scale is true scale at every latitude", () => {
    const { constants } = makeEnvironment(10, 20, 1);
    expect(constants.globe.transition).toBe(0);
    for (const latitude of [0, 12, 60]) {
      const anchor = SceneModelAnchorMath.resolveAnchor(makePresented(latitude, 20), unitBounds, constants);
      const expected = (2 * Math.PI * constants.globe.radius) / ImmersiveMapProjection.earthCircumferenceMeters;
      expectClose(length3(column(anchor.modelMatrix, 0)) / expected, 1, 1e-3);
    }
  });

  test("the altitude lifts the anchor along up by meters", () => {
    const latitude = 55.75;
    const { constants, presentation } = makeEnvironment(latitude, 37.61, 15);
    expect(constants.mode).toBe("flat");
    const grounded = SceneModelAnchorMath.resolveAnchor(makePresented(latitude, 37.61), unitBounds, constants);
    const lifted = SceneModelAnchorMath.resolveAnchor(makePresented(latitude, 37.61, { altitudeMeters: 100 }), unitBounds, constants);
    const unitsPerMeter = ImmersiveMapProjection.worldUnitsPerMeter((latitude * Math.PI) / 180, presentation.flatRenderState.renderMapSize);
    const groundedPosition = translation(grounded.modelMatrix);
    const liftedPosition = translation(lifted.modelMatrix);
    expectClose(liftedPosition[0], groundedPosition[0], 1e-6);
    expectClose(liftedPosition[1], groundedPosition[1], 1e-6);
    expectClose((liftedPosition[2] - groundedPosition[2]) / (100 * unitsPerMeter), 1, 1e-3);
  });

  test("the ground plane is the surface under a sunk anchor", () => {
    const latitude = 55.75;
    const { constants, presentation } = makeEnvironment(latitude, 37.61, 15);
    const sunk = SceneModelAnchorMath.resolveAnchor(makePresented(latitude, 37.61, { altitudeMeters: -20 }), unitBounds, constants);
    // The plane is the surface at altitude zero: the sunk origin lies below
    // it by the altitude, along the plane's up, which is the flat map's z.
    const unitsPerMeter = ImmersiveMapProjection.worldUnitsPerMeter((latitude * Math.PI) / 180, presentation.flatRenderState.renderMapSize);
    const height = dot3(sub3(translation(sunk.modelMatrix), sunk.groundPlane.surfacePosition), sunk.groundPlane.up);
    expectClose(height / (-20 * unitsPerMeter), 1, 1e-3);
    expectDirection(sunk.groundPlane.up, [0, 0, 1]);
    expectClose(sunk.groundPlane.surfacePosition[2], 0, 1e-6);
  });

  test("the fit diameter overrides the native size", () => {
    const { constants } = makeEnvironment(0, 0, 15);
    const bounds = makeSceneModelBounds([-2, -2, -2], [2, 2, 2]);
    const native = SceneModelAnchorMath.resolveAnchor(makePresented(0, 0), bounds, constants);
    const fitted = SceneModelAnchorMath.resolveAnchor(makePresented(0, 0, { fitDiameterMeters: 200 }), bounds, constants);
    expectClose(length3(column(fitted.modelMatrix, 0)) / length3(column(native.modelMatrix, 0)), 50, 0.05);
  });

  test("the bounding sphere is the bounds' sphere carried by the model matrix", () => {
    const { constants } = makeEnvironment(0, 0, 15);
    const bounds = makeSceneModelBounds([-1, 0, -1], [1, 6, 1]);
    const anchor = SceneModelAnchorMath.resolveAnchor(makePresented(0, 0, { scale: 2 }), bounds, constants);
    const scale = length3(column(anchor.modelMatrix, 0));
    expectClose(anchor.boundingSphereRadius, bounds.radius * scale, 1e-12);
    // The box center (0, 3, 0) is 3 asset units up: along world z in flat mode.
    const offset = sub3(anchor.boundingSphereCenter, translation(anchor.modelMatrix));
    expectDirection(normalize3(offset), [0, 0, 1]);
    expectClose(length3(offset), 3 * scale, 1e-9);
  });

  // Horizon gate and antimeridian

  test("a far side anchor fails the horizon gate", () => {
    const { constants } = makeEnvironment(0, 0, 1);
    expect(constants.mode).toBe("globe");
    expect(SceneModelAnchorMath.resolveAnchor(makePresented(-10, -160), unitBounds, constants).passesHorizonGate).toBe(false);
    expect(SceneModelAnchorMath.resolveAnchor(makePresented(2, 3), unitBounds, constants).passesHorizonGate).toBe(true);
  });

  test("a flat anchor across the antimeridian wraps near the camera", () => {
    const { constants } = makeEnvironment(0, 179.9, 10);
    expect(constants.mode).toBe("flat");
    const presented = makePresented(0, -179.9);
    const anchor = SceneModelAnchorMath.resolveAnchor(presented, unitBounds, constants);
    const projected = GeoScreenProjectionMath.project(presented.projectionBasis, constants);
    const anchorScreen = screenPoint(translation(anchor.modelMatrix), constants)!;
    expect(projected.visible).not.toBe(0);
    expectClose(anchorScreen[0], projected.positionX, 0.01);
    expectClose(anchorScreen[1], projected.positionY, 0.01);
  });
});

describe("SceneModelBounds", () => {
  test("the center, radius and extent derive from the box", () => {
    const bounds = makeSceneModelBounds([-1, -1, -1], [1, 1, 1]);
    expect(bounds.center).toEqual([0, 0, 0]);
    expectClose(bounds.radius, Math.sqrt(3), 1e-12);
    expect(bounds.maxExtent).toBe(2);
    const flat = makeSceneModelBounds([0, 0, 0], [0, 0, 0]);
    expect(flat.radius).toBe(1e-6);
    expect(flat.maxExtent).toBe(1e-6);
  });
});
