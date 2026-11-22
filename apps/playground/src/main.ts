// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { watchMapRemotely } from "./remote-log.ts";
import { type FrameEvent, ImmersiveMap, ImmersiveMapPin, ImmersiveMapSceneModel, ImmersiveMapSettings, ImmersiveMapTerrainSource, ImmersiveMapTilesService, type TileLoadedEvent } from "@artembobkin/immersive-map";
import { addSampleAnnotations } from "./sample-annotations.ts";
import { addTraceRecorder } from "./trace-recorder.ts";
import { addSamplePins } from "./sample-pins.ts";
import { addSampleExport } from "./sample-export.ts";
import { addSampleLayers } from "./sample-layers.ts";
import { addSampleSceneModels } from "./sample-scene-models.ts";

const hud = document.getElementById("hud")!;
const params = new URLSearchParams(location.search);
const lon = Number(params.get("lon") ?? 37.6175);
const lat = Number(params.get("lat") ?? 55.752);
const zoom = Number(params.get("zoom") ?? 13);
const degrees = Math.PI / 180;
const bearing = Number(params.get("bearing") ?? 0) * degrees;
const pitch = Number(params.get("pitch") ?? 0) * degrees;

const tiles: TileLoadedEvent[] = [];
let lastFrame: FrameEvent | undefined;
const frameTimes: number[] = [];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function render(map: ImmersiveMap): void {
  const parses = tiles.flatMap((t) => (t.parseMilliseconds === undefined ? [] : [t.parseMilliseconds]));
  const gpuBytes = tiles.reduce((sum, t) => sum + t.gpuBytes, 0);
  const view = map.view;
  const frame = lastFrame;
  hud.innerHTML = [
    `<b>view</b>     ${view.center[0].toFixed(4)}, ${view.center[1].toFixed(4)}  z ${view.zoom.toFixed(2)}  bearing ${(view.bearing / degrees).toFixed(0)}°  pitch ${(view.pitch / degrees).toFixed(0)}°`,
    `<b>frame</b>    cpu ${frame?.cpuMilliseconds.toFixed(2) ?? "n/a"} ms (median ${median(frameTimes).toFixed(2)})  gpu ${frame?.gpuMilliseconds?.toFixed(2) ?? "n/a"} ms`,
    `<b>draws</b>    ${frame?.draws ?? 0}   tiles ${frame?.renderedTiles ?? 0} drawn, ${frame?.visibleTiles ?? 0} visible, ${frame?.loadingTiles ?? 0} loading`,
    `<b>loaded</b>   ${tiles.length} tiles, ${(gpuBytes / 1e6).toFixed(1)} MB uploaded, ${tiles.length - parses.length} from disk`,
    `<b>worker</b>   parse median ${median(parses).toFixed(2)} ms  max ${Math.max(0, ...parses).toFixed(2)} ms`,
  ].join("\n");
}

let settings = ImmersiveMapSettings.default;
if (params.get("night") === "1") settings = settings.night();
// `globe=0` keeps the flat map at every zoom (for A/B measurements).
if (params.get("globe") === "0") settings = settings.globe({ isEnabled: false });
// Stage 4 switches, for the antialiasing screenshots (B16) and A/B measurements.
if (params.get("msaa") === "1") settings = settings.msaa({ isEnabled: true });
if (params.get("fxaa") === "1") settings = settings.fxaa({ isEnabled: true });
if (params.get("shadows") === "0") settings = settings.shadows({ isEnabled: false });
if (params.get("trees") === "0") settings = settings.trees({ isEnabled: false });
// Stage 5: `relief=1` raises the ground on the terrain, `terrain=` names a
// template of its tiles in place of Mapterhorn's (the smoke test reads the
// fixtures with `terrain=/fixtures/terrain/{z}-{x}-{y}.webp`).
if (params.get("relief") === "1") settings = settings.groundRelief({ isEnabled: true });
// `reliefShadows=1` lets the shadows in from zoom 11, where the relief stands, so the mountains cast.
if (params.get("reliefShadows") === "1") settings = settings.shadows({ strength: { 11: 0.45, 13: 0.45 } });
// `shadowResolution=2048` sizes the shadow map (A/B measurements of the caster passes).
// `edgeRadius=<metres>` sets how far the buildings' edges are rounded (0 keeps sharp boxes), for A/B measurements.
const edgeRadius = params.get("edgeRadius");
if (edgeRadius !== null) settings = settings.edit((s) => void (s.mapStyle.theme.features.buildingEdgeRadius = Number(edgeRadius)));
const shadowResolution = params.get("shadowResolution");
if (shadowResolution) settings = settings.edit((s) => void (s.scene.shadows.mapResolution = Number(shadowResolution)));
const terrain = params.get("terrain");
if (terrain) settings = settings.terrain(ImmersiveMapTerrainSource.make({ tileURLTemplate: terrain, encoding: "terrarium", credit: null }));
const archive = params.get("archive");
// The map draws no building models by default. `modelArchive=hosted` reads
// the hosted archive, `modelArchive=<url>` another one (`/fixtures/models.pmtiles`
// the local fixtures).
const modelArchive = params.get("modelArchive");
if (modelArchive === "hosted") settings = settings.modelArchive(ImmersiveMapTilesService.modelArchiveURL);
else if (modelArchive && modelArchive !== "none") settings = settings.modelArchive(modelArchive);
const map = await ImmersiveMap.create({
  container: document.getElementById("map")!,
  settings,
  camera: { center: [lon, lat], zoom, bearing, pitch },
  ...(archive ? { url: archive } : {}),
  // `cameraControls=1` shows the on-screen camera panel (stage 8).
  cameraControls: params.get("cameraControls") === "1",
  // `debug=1` installs the debug panel (stage 9), from its own entry, loaded only then.
  ...(params.get("debug") === "1" ? { debugPanel: (await import("@artembobkin/immersive-map/debug")).ImmersiveMapDebugPanel.hud } : {}),
});
let hudQueued = false;
const queueHud = () => {
  if (hudQueued) return;
  hudQueued = true;
  requestAnimationFrame(() => {
    hudQueued = false;
    render(map);
  });
};
map.onTileLoaded((event) => {
  tiles.push(event);
  queueHud();
});
// What scripts/screenshots.mjs waits on: the last frame's time and tile counts.
const settle = { visible: 0, loading: 0, lastFrame: 0 };
map.onFrame((event) => {
  lastFrame = event;
  settle.visible = event.visibleTiles;
  // The terrain the relief waits for counts as loading: a settled frame has its mountains.
  settle.loading = event.loadingTiles + event.pendingTerrainTiles + event.pendingLayerMeshes + event.pendingSceneModelMeshes;
  settle.lastFrame = performance.now();
  frameTimes.push(event.cpuMilliseconds);
  if (frameTimes.length > 300) frameTimes.shift();
  queueHud();
});
Object.assign(window, { map, tileStats: tiles, mapSettle: settle });
// `annotations=1` stands a few DOM annotations near the default view (stage 6).
if (params.get("annotations") === "1") addSampleAnnotations(map);
// `pins=1` stands sample pins with locally drawn pictures, and a selection controller (stage 6).
if (params.get("pins") === "1") addSamplePins(map);
// `layers=1` draws a sample of the app's own data over central Moscow (stage 6).
if (params.get("layers") === "1") addSampleLayers(map);
// `export=1` adds the export panel: a still and a short tour to MP4 (stage 8).
if (params.get("export") === "1") addSampleExport(map);
// `models=1` stands a sample glTF model by the default view (stage 7).
if (params.get("models") === "1") addSampleSceneModels(map);
// `trace=1` records the pointer, the frames and the long tasks for a person's own session.
if (params.get("trace") === "1") addTraceRecorder(map);
// `remotelog=1` sends the console and the map's state to the dev server, for a phone.
watchMapRemotely(map);
// What scripts/screenshots.mjs adds the reference's pins and scene models with.
Object.assign(window, { ImmersiveMapPin, ImmersiveMapSceneModel, ImmersiveMapSettings });
// The debug panel stands where the playground's own HUD does.
if (params.get("hud") === "0" || params.get("debug") === "1") for (const id of ["hud", "bench"]) document.getElementById(id)!.style.display = "none";
