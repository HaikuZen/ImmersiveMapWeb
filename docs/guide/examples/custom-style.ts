// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/CustomStyle.md.

import { ImmersiveMap, ImmersiveMapSettings } from "@artembobkin/immersive-map";

/** A grey look of the app's own, written as changes to the built-in theme. */
export async function monoStyle(container: HTMLElement): Promise<ImmersiveMap> {
  const grey = (level: number): [number, number, number, number] => [level, level, level, 1];

  const settings = ImmersiveMapSettings.default.edit((draft) => {
    const theme = draft.mapStyle.theme;
    theme.layers.land = grey(0.95);
    theme.layers.water = [0.75, 0.8, 0.85, 1];
    for (const cover of ["wood", "grass", "farmland", "sand", "wetland", "park", "residential", "industrial"] as const) {
      theme.layers[cover] = grey(0.93);
    }
    theme.labels.city.fillColor = [0.2, 0.2, 0.2];
    theme.labels.city.strokeColor = [1, 1, 1];
    theme.labels.city.weight = "bold";
  });

  const map = await ImmersiveMap.create({ container, settings });
  return map;
}

/** The globe's own biomes left out, for an archive whose land cover the app wants seen at every zoom. */
export const noOverview: ImmersiveMapSettings = ImmersiveMapSettings.default.overviewTiles({ isEnabled: false });
