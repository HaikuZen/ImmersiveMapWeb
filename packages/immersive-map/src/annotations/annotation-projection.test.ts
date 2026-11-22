// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The frame's annotation projection (Swift `AnnotationRenderSubsystem.update`):
// the point the camera looks at lands in the middle of the drawable, and a
// point behind the globe is left out of the snapshot.

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../camera/render-camera-pose-resolver.ts";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { type GeoCoordinate, geoCoordinate } from "../geo/geo-coordinate.ts";
import { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import { projectAnnotations } from "./annotation-projection.ts";

const drawWidth = 640;
const drawHeight = 480;

function constantsLookingAt(center: GeoCoordinate, zoom: number): GeoScreenProjectionFrameConstants {
  const world = ImmersiveMapProjection.worldMercator((center.latitude * Math.PI) / 180, (center.longitude * Math.PI) / 180);
  const cameraState = ImmersiveMapCameraState.make(world, zoom, 0, 0);
  const presentation = PresentationStateResolver.resolve(cameraState, ImmersiveMapSettings.default.presentation);
  const renderCamera = new RenderCamera();
  renderCamera.recalculateProjection(drawWidth / drawHeight);
  new RenderCameraPoseResolver().updateIfNeeded(renderCamera, cameraState, presentation.presentationState.transition);
  return new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, { matrix: renderCamera.cameraMatrix!.slice(), eye: renderCamera.eye }, presentation);
}

describe("projectAnnotations", () => {
  test("the point under the camera lands in the middle of the flat map", () => {
    const moscow = geoCoordinate(55.752, 37.6175);
    const snapshot = projectAnnotations({ entries: [{ id: 7, basis: GeoProjectionBasis.fromCoordinate(moscow) }] }, constantsLookingAt(moscow, 14), 3);
    expect(snapshot.frameIndex).toBe(3);
    expect(snapshot.drawWidth).toBe(drawWidth);
    expect(snapshot.drawHeight).toBe(drawHeight);
    expect(snapshot.entries.length).toBe(1);
    const entry = snapshot.entries[0]!;
    expect(entry.id).toBe(7);
    expect(entry.positionX).toBeCloseTo(drawWidth / 2, 1);
    expect(entry.positionY).toBeCloseTo(drawHeight / 2, 1);
    expect(entry.visibilityAlpha).toBe(1);
  });

  test("a point on the far side of the globe is left out, the near one kept", () => {
    const constants = constantsLookingAt(geoCoordinate(0, 0), 1.5);
    const snapshot = projectAnnotations(
      {
        entries: [
          { id: 1, basis: GeoProjectionBasis.fromCoordinate(geoCoordinate(0, 0)) },
          { id: 2, basis: GeoProjectionBasis.fromCoordinate(geoCoordinate(0, 180)) },
        ],
      },
      constants,
      1,
    );
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([1]);
    expect(snapshot.entries[0]!.visibilityAlpha).toBeGreaterThan(0);
  });
});
