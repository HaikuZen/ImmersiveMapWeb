// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/GettingStarted.md.

import { ImmersiveMap, ImmersiveMapSettings } from "@immersive-map/web";

/** The first map: the whole planet from the hosted tiles, with the built-in style. */
export async function firstMap(): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container: document.getElementById("map")!,
  });
  return map;
}

/** The options and the settings of one map. */
export async function configuredMap(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    camera: { city: "paris", zoom: 15 },
    settings: ImmersiveMapSettings.default
      .night()
      .shadows({ strength: 0.6 })
      .trees({ isEnabled: false }),
  });
  return map;
}

/** One settings value for several maps. */
export async function sharedSettings(first: HTMLElement, second: HTMLElement): Promise<ImmersiveMap[]> {
  const settings = ImmersiveMapSettings.default
    .night()
    .shadows({ strength: 0.6 });

  const maps = await Promise.all([
    ImmersiveMap.create({ container: first, settings, camera: { city: "paris" } }),
    ImmersiveMap.create({ container: second, settings, camera: { city: "rome" } }),
  ]);
  return maps;
}

/** Settings changed on a running map. */
export async function changingSettings(map: ImmersiveMap, nightToggle: HTMLInputElement): Promise<void> {
  nightToggle.addEventListener("change", () => {
    void map.setSettings((settings) => settings.night(nightToggle.checked));
  });

  // A whole value works too, and the promise resolves once the map draws by it.
  await map.setSettings(ImmersiveMapSettings.default.shadows({ isEnabled: false }));
}

/** The map torn down with the page part that holds it. */
export function teardown(map: ImmersiveMap): void {
  map.destroy();
}

/** The debug panel, from its own entry, loaded only when asked for. */
export async function withDebugPanel(container: HTMLElement): Promise<ImmersiveMap> {
  const { ImmersiveMapDebugPanel } = await import("@immersive-map/web/debug");
  const map = await ImmersiveMap.create({ container, debugPanel: ImmersiveMapDebugPanel.hud });
  return map;
}

/** A value no method sets, changed on a copy of the settings' data. */
export function editedSettings(settings: ImmersiveMapSettings): ImmersiveMapSettings {
  return settings.edit((s) => void (s.scene.shadows.mapResolution = 2048));
}
