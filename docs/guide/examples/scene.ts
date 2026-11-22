// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Scene.md.

import { ImmersiveMap, ImmersiveMapSettings } from "@artembobkin/immersive-map";

/** The scene's look, in one settings value. */
export async function sceneMap(container: HTMLElement): Promise<ImmersiveMap> {
  const settings = ImmersiveMapSettings.default
    .sceneLight({ direction: [-0.5, -0.4, 0.8] }) // towards the sun: x east, y north, z up
    .shadows({ strength: 0.6, softness: 1.5 })
    .groundFog({ startDistanceMeters: { 12: 3000, 16: 400 } })
    .buildingExtrusion({ buildingsMinimumZoom: 15, risesFromTheGround: false })
    .trees({ minimumZoom: 15, maximumPerTile: 2000 });

  const map = await ImmersiveMap.create({ container, settings, camera: { city: "london", zoom: 16, pitch: 1.0 } });
  return map;
}

/** The globe and space. */
export const globeAndSpace: ImmersiveMapSettings = ImmersiveMapSettings.default
  .globe({ isEnabled: false }) // a flat map at every zoom
  .atmosphere({ isEnabled: false }) // no glow around the globe
  .transparentSpace(); // the page's own background around the globe

/** The sun on the globe moved, and the globe lit evenly. */
export function globeLight(): ImmersiveMapSettings[] {
  const movedSun = ImmersiveMapSettings.default.globeLight({
    subsolarLatitudeDegrees: 10,
    subsolarLongitudeDegrees: 30,
    strength: { 2: 0.8, 6: 0.2 },
    nightColor: [0.02, 0.03, 0.08],
  });
  const evenLight = ImmersiveMapSettings.default.globeLight({ isEnabled: false });
  return [movedSun, evenLight];
}

/** No shadows. */
export const noShadows: ImmersiveMapSettings = ImmersiveMapSettings.default.shadows({ isEnabled: false });

/** Shadows that reach farther from the camera. */
export const fartherShadows: ImmersiveMapSettings = ImmersiveMapSettings.default.shadows({ nearCoverageMeters: { 14: 4000, 18: 300 } });

/** No sky gradient, and no ground fog. */
export const noFog: ImmersiveMapSettings = ImmersiveMapSettings.default
  .fog({ isEnabled: false }) // no sky gradient
  .groundFog({ isEnabled: false }); // no ground fog

/** The ground fog tuned by zoom. */
export const groundFog: ImmersiveMapSettings = ImmersiveMapSettings.default.groundFog({
  heightMeters: 120,
  startDistanceMeters: { 12: 3000, 16: 400 },
  startSoftnessMeters: { 12: 20_000, 16: 800 },
  maximumOpacity: { 18: 1, 19: 0 },
});

/** No trees. */
export const noTrees: ImmersiveMapSettings = ImmersiveMapSettings.default.trees({ isEnabled: false });

/** Smoother edges. */
export function smootherEdges(): ImmersiveMapSettings[] {
  const msaa = ImmersiveMapSettings.default.msaa(); // 4 samples a pixel, the cleaner of the two
  const fxaa = ImmersiveMapSettings.default.fxaa(); // one cheap pass over the finished frame
  return [msaa, fxaa];
}
