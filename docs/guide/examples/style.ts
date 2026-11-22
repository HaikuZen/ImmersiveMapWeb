// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Style.md.

import { ImmersiveMap, ImmersiveMapSettings, LabelLanguage, nightFogSettings, zoomCurve } from "@artembobkin/immersive-map";

/** The built-in look with a few colours changed. */
export async function changedColours(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    settings: ImmersiveMapSettings.default.edit((settings) => {
      const theme = settings.mapStyle.theme;
      theme.layers.water = [0.55, 0.75, 0.95, 1];
      theme.layers.park = [0.7, 0.86, 0.62, 1];
      theme.labels.city.sizePoints = 18;
    }),
  });
  return map;
}

/** The POIs faded in by zoom. */
export const fadedPois: ImmersiveMapSettings = ImmersiveMapSettings.default.edit((settings) => {
  settings.mapStyle.theme.labelOpacity.pois = zoomCurve({ 14: 0.6, 16: 1 });
});

/** The night palette and sky, and the day again. */
export function night(map: ImmersiveMap, isNight: boolean): Promise<void> {
  return map.setSettings((settings) => settings.night(isNight));
}

/** A night of the app's own: the night palette with darker water, and the night sky. */
export const ownNight: ImmersiveMapSettings = ImmersiveMapSettings.default
  .night()
  .edit((settings) => {
    settings.mapStyle.theme.layers.water = [0.02, 0.04, 0.1, 1];
  })
  .fogSettings(nightFogSettings);

/** The zoomed-out globe in a palette of its own. */
export const globeColours: ImmersiveMapSettings = ImmersiveMapSettings.default.edit((settings) => {
  const theme = settings.mapStyle.theme;
  theme.globeLayers = { ...theme.layers, water: [0.2, 0.4, 0.8, 1] };
});

/** The names in Russian. */
export const russianNames: ImmersiveMapSettings = ImmersiveMapSettings.default.labelSettings({ language: LabelLanguage.russian });

/** Any language code the tiles carry names in, the local name first. */
export const polishNames: ImmersiveMapSettings = ImmersiveMapSettings.default.labelSettings({ language: "pl", fallbackPolicy: "localFirst" });

/** No names at all. */
export const noNames: ImmersiveMapSettings = ImmersiveMapSettings.default.labels({ isEnabled: false });
