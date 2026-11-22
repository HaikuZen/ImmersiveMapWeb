// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileCullingBackdropTests`: the rules' bands are the
// whole coverage of the flat map, nothing is placed under them, and no band
// goes down to the world cover's zoom.

import { describe, expect, test } from "vitest";
import { FrameCameraStateResolver } from "../../camera/frame-camera-state-resolver.ts";
import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import type { ViewMode } from "../../camera/view-mode.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import { PresentationStateResolver } from "../../presentation/presentation-state-resolver.ts";
import { TileCulling, type TileCullingInputs } from "./tile-culling.ts";

function makeFixture(zoom: number, renderSurfaceMode: ViewMode): Omit<TileCullingInputs, "targetZoom"> {
  const settings = ImmersiveMapSettings.default;
  const center = ImmersiveMapProjection.worldMercator((40.7 * Math.PI) / 180, (-74.0 * Math.PI) / 180);
  const resolver = new FrameCameraStateResolver(settings);
  resolver.setCameraState(ImmersiveMapCameraState.make(center, zoom, 0, 0));
  const frame = resolver.makeFrameState(1024, 768);
  if (frame === null) throw new Error("a camera frame state is required for the tile culling fixture");
  const resolvedPresentation = PresentationStateResolver.resolve(frame.mapCameraState, settings.presentation, renderSurfaceMode);
  return {
    cameraState: frame.mapCameraState,
    resolvedPresentation,
    cameraMatrix: new Float64Array(frame.cameraMatrices.projectionView),
    cameraFrustum: frame.cameraFrustum,
    cameraEye: frame.cameraEye,
  };
}

describe("TileCulling", () => {
  test("flat mode stays above the floor zoom", () => {
    const fixture = makeFixture(9.0, "flat");
    const content = new TileCulling().resolveVisibleContent({ ...fixture, targetZoom: 9 });
    expect(content.visibleTiles.length).toBeGreaterThan(0);
    expect(content.visibleTiles.every((t) => t.tile.z === 9), "straight down: the first rule at the target zoom").toBe(true);
    expect(content.visibleTiles.every((t) => t.tile.z > TileCulling.flatBackdropZoomLevel)).toBe(true);
  });

  /**
   * The coverage version is the working set's gate: it moves when the
   * targets differ from the last frame's, and not when the walk merely ran
   * again over the same pose.
   */
  test("the coverage version moves only with the coverage", () => {
    const culling = new TileCulling();
    const fixture = makeFixture(9.0, "flat");
    const first = culling.resolveVisibleContent({ ...fixture, targetZoom: 9 });
    const again = culling.resolveVisibleContent({ ...fixture, targetZoom: 9 });
    expect(again.visibleTiles).toEqual(first.visibleTiles);
    expect(again.coverageVersion, "the same coverage keeps its version").toBe(first.coverageVersion);
    const coarser = culling.resolveVisibleContent({ ...fixture, targetZoom: 8 });
    expect(coarser.visibleTiles).not.toEqual(first.visibleTiles);
    expect(coarser.coverageVersion, "a different coverage moves it").not.toBe(first.coverageVersion);
  });
});
