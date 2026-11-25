// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The dev page: the one feature being worked on now, the tile grid, on a
// map with a panel of its settings. Nothing else of the engine is shown
// here: the playground (apps/playground) holds every sample, the smoke
// tests' pages.
//   npm run dev        http://localhost:5180

import { type FrameEvent, ImmersiveMap, ImmersiveMapGeoBounds, ImmersiveMapSettings, ImmersiveMapTileGridController, ImmersiveMapTileID } from "@artembobkin/immersive-map";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => element<HTMLInputElement>(id);
const select = (id: string): HTMLSelectElement => element<HTMLSelectElement>(id);
const degrees = Math.PI / 180;

const grid = new ImmersiveMapTileGridController();
const map = await ImmersiveMap.create({
  container: element("map"),
  camera: { center: [37.6175, 55.752], zoom: 13.2 },
  tileGrid: grid,
});

/** The centre of Moscow within the Garden Ring, roughly. */
const gardenRing = ImmersiveMapGeoBounds.make({ latitude: 55.729, longitude: 37.583 }, { latitude: 55.774, longitude: 37.658 });

/** The settings of the page's controls, over the map's defaults. */
function settingsOfThePanel(): ImmersiveMapSettings {
  const format = select("labelFormat").value;
  const limit = input("limit").value.trim();
  let settings = ImmersiveMapSettings.default
    .tileGridSettings({
      zoomRange: [Number(input("zoomMin").value), Number(input("zoomMax").value)],
      labelFormat: format === "xyz" || format === "hidden" ? format : "zxy",
      lineWidthPoints: Number(input("lineWidth").value),
      maximumDrawnTiles: Number(input("maximumTiles").value),
      selectionGesture: select("gesture").value as "tap" | "doubleTap" | "secondaryTap",
      selectionMode: select("mode").value as "multiple" | "single",
      isTapSelectionEnabled: input("tapEnabled").checked,
    })
    .tileGridSelection({ limit: limit === "" ? null : Number(limit), selectableBounds: input("bounds").checked ? gardenRing : null })
    .doubleTapZoom(input("doubleTapZoom").checked);
  if (input("night").checked) settings = settings.night();
  if (input("flat").checked) settings = settings.globe({ isEnabled: false });
  return settings;
}

function apply(): void {
  map.setSettings(() => settingsOfThePanel());
  // The app's own text: every other column carries one, the rest none.
  grid.labelProvider = select("labelFormat").value === "own" ? (tile) => (tile.x % 2 === 0 ? `tile ${tile.x % 100}·${tile.y % 100}` : null) : null;
  map.tileGrid = input("shown").checked ? grid : null;
}

for (const control of document.querySelectorAll("#panel input, #panel select")) control.addEventListener("change", apply);
apply();

// The selection and what the taps came to.
const events: string[] = [];
const log = (line: string): void => {
  events.unshift(line);
  events.length = Math.min(events.length, 40);
  element("events").textContent = events.join("\n");
};
const showSelection = (): void => {
  const keys = grid.selectedTiles.map(ImmersiveMapTileID.key);
  element("tiles").textContent = keys.length === 0 ? "none" : `${keys.length}: ${keys.join("  ")}`;
};
grid.onSelectionChanged = (change) => {
  showSelection();
  log(`${change.source}: +${change.added.map(ImmersiveMapTileID.key).join(",") || "—"}  −${change.removed.map(ImmersiveMapTileID.key).join(",") || "—"}`);
};
grid.onTapRejected = (rejection) => log(`rejected ${ImmersiveMapTileID.key(rejection.tile)}: ${rejection.reason.kind}`);

element("clear").addEventListener("click", () => grid.clearSelection());
element("selectView").addEventListener("click", () => {
  const view = map.view;
  const zoom = Math.min(Math.max(Math.floor(view.zoom), Number(input("zoomMin").value)), Number(input("zoomMax").value));
  grid.toggle(ImmersiveMapTileID.containing({ latitude: view.center[1], longitude: view.center[0] }, zoom));
});
for (const button of document.querySelectorAll<HTMLButtonElement>("#panel button[data-view]")) {
  button.addEventListener("click", () => {
    const [zoom, pitch] = button.dataset.view!.split(",").map(Number);
    map.view = { zoom: zoom!, pitch: pitch! * degrees };
  });
}

// The frame's numbers, at most once an animation frame.
let last: FrameEvent | undefined;
let queued = false;
const cpu: number[] = [];
map.onFrame((event) => {
  last = event;
  cpu.push(event.cpuMilliseconds);
  if (cpu.length > 120) cpu.shift();
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const view = map.view;
    const median = [...cpu].sort((a, b) => a - b)[Math.floor(cpu.length / 2)] ?? 0;
    element("stats").textContent = [
      `zoom ${view.zoom.toFixed(2)}  pitch ${(view.pitch / degrees).toFixed(0)}°  bearing ${(view.bearing / degrees).toFixed(0)}°`,
      `${view.center[1].toFixed(4)}, ${view.center[0].toFixed(4)}`,
      `grid tiles ${last?.drawnTileGridTiles ?? 0}`,
      `cpu ${median.toFixed(2)} ms (median)  gpu ${last?.gpuMilliseconds?.toFixed(2) ?? "n/a"} ms`,
    ].join("\n");
  });
});

// For the console.
Object.assign(window, { map, grid, ImmersiveMapTileID, ImmersiveMapSettings });
