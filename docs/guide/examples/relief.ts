// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Relief.md.

import { ImmersiveMap, ImmersiveMapSettings, ImmersiveMapTerrainSource } from "@artembobkin/immersive-map";

/** The relief turned on, over Zermatt. */
export async function reliefOn(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    camera: { center: [7.7491, 46.0207], zoom: 12, pitch: 1.1 },
    settings: ImmersiveMapSettings.default.groundRelief({ isEnabled: true }),
  });
  return map;
}

/** When the relief rises and sinks. */
export const reliefZooms: ImmersiveMapSettings = ImmersiveMapSettings.default.groundRelief({
  isEnabled: true,
  appearZoom: 9,
  collapseZoom: 15,
  transitionSeconds: 0.5,
});

/** The relief up to the collapse zoom everywhere, also where the terrain has no finer tile. */
export const reliefEverywhere: ImmersiveMapSettings = ImmersiveMapSettings.default.groundRelief({
  isEnabled: true,
  collapsesWhereTerrainIsMissing: false,
});

/** The heights multiplied. */
export const exaggerated: ImmersiveMapSettings = ImmersiveMapSettings.default.groundRelief({ isEnabled: true, exaggeration: 1.5 });

/** Terrain tiles of the app's own. */
export const ownTerrain: ImmersiveMapSettings = ImmersiveMapSettings.default
  .terrain(
    ImmersiveMapTerrainSource.make({
      tileURLTemplate: "https://terrain.example.com/{z}/{x}/{y}.png",
      encoding: "mapbox",
      credit: "© Example Terrain",
    }),
  )
  .groundRelief({ isEnabled: true });

/** The shading of the slopes and of the valleys. */
export const shading: ImmersiveMapSettings = ImmersiveMapSettings.default
  .groundRelief({ isEnabled: true })
  .edit((settings) => {
    settings.mapStyle.theme.hillshade.intensity = 0.5;
    settings.mapStyle.theme.terrainOcclusion.strength = 0.3;
  });

/** The camera kept over the ridges. */
export const clearance: ImmersiveMapSettings = ImmersiveMapSettings.default.groundRelief({ isEnabled: true, cameraClearanceMetres: 50 });

/** Mountains or a plain under the camera. */
export function surroundings(map: ImmersiveMap, badge: HTMLElement): () => void {
  const stop = map.onTerrainSurroundingsChange((surroundings) => {
    // surroundings?.kind is "mountains" or "plain", null off the relief
    badge.textContent = surroundings === null ? "" : surroundings.kind;
  });
  return stop;
}

/** How the surroundings are read. */
export const surroundingsReading: ImmersiveMapSettings = ImmersiveMapSettings.default.terrainSurroundings({
  sampleRadiusMetres: 3000,
  plainBelowMetres: 150,
  mountainsAboveMetres: 600,
  smoothingHalfLife: 0.5,
});
