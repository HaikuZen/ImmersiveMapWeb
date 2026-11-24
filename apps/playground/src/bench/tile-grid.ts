// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B23: the tile grid's frame, where it is worked out. Three variants of
// what a frame does once the camera has moved, on the frames of real poses
// (the engine's own camera over Moscow and over the globe, a 2400 by 1720
// drawable at 2 pixels a point):
// - "Rust/Wasm": the map's own. One call resolves the zoom, walks the tiles
//   nearest first, marks the selected, writes the tiles as the GPU takes
//   them and lays the glyphs of their texts (crates/frame-wasm, TileGridFrame).
// - "Rust/Wasm, glyphs in TypeScript": the same call without the texts, and
//   the glyphs put together on this side from the tiles read back.
// - "TypeScript": all of it in TypeScript (ts-tile-grid.ts), the plane only.
// Every variant ends with the same bytes for the GPU, checked before the
// timing.

import { FrameCameraStateResolver } from "../../../../packages/immersive-map/src/camera/frame-camera-state-resolver.ts";
import { ImmersiveMapCameraState } from "../../../../packages/immersive-map/src/camera/immersive-map-camera-state.ts";
import { ImmersiveMapSettings } from "../../../../packages/immersive-map/src/configuration/immersive-map-settings.ts";
import { tileGridSettings, type TileGridSettings } from "../../../../packages/immersive-map/src/configuration/tile-grid-settings.ts";
import { initFrameWasm } from "../../../../packages/immersive-map/src/frame/frame-wasm.ts";
import { ImmersiveMapProjection } from "../../../../packages/immersive-map/src/geo/immersive-map-projection.ts";
import { tileNumber } from "../../../../packages/immersive-map/src/geo/immersive-map-tile-id.ts";
import { PresentationStateResolver } from "../../../../packages/immersive-map/src/presentation/presentation-state-resolver.ts";
import { ImmersiveMapTileGridController } from "../../../../packages/immersive-map/src/tile-grid/immersive-map-tile-grid-controller.ts";
import { layOutTileGridText, makeTileGridAtlas, type TileGridAtlasSource } from "../../../../packages/immersive-map/src/tile-grid/tile-grid-atlas.ts";
import { TileGridFrame, type TileGridFrameInput } from "../../../../packages/immersive-map/src/tile-grid/tile-grid-frame.ts";
import { tileGridFrameOf } from "../../../../packages/immersive-map/src/ui/immersive-map-tile-grid-runtime.ts";
import { coverageFootprint } from "../../../../packages/immersive-map/src/wasm/frame_wasm/frame_wasm.js";
import { done, fail, publish, stat } from "./harness.ts";
import { TsPolygon, TsTileGrid, type TsLayout } from "./ts-tile-grid.ts";

const WIDTH = 2400;
const HEIGHT = 1720;
const PIXELS_PER_POINT = 2;
/** The frames of a scene: the camera a step further along a pan on each, so every one is worked out anew. */
const FRAMES = 32;
const BATCHES = 80;
const WARMUP = 10;

interface Scene {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number;
  readonly pitch: number;
  readonly bearing: number;
  readonly gridZoom: readonly [number, number];
}

const scenes: Scene[] = [
  { name: "сверху, z13.2, сетка z15", latitude: 55.752, longitude: 37.6175, zoom: 13.2, pitch: 0, bearing: 0, gridZoom: [15, 15] },
  { name: "наклон 62°, z14.2, сетка z15", latitude: 55.752, longitude: 37.6175, zoom: 14.2, pitch: 62, bearing: 30, gridZoom: [15, 15] },
  { name: "к горизонту, z15.5, сетка z16 (предел 512)", latitude: 55.752, longitude: 37.6175, zoom: 15.5, pitch: 80, bearing: 30, gridZoom: [16, 16] },
  { name: "глобус, z2.6", latitude: 40, longitude: 20, zoom: 2.6, pitch: 0, bearing: 0, gridZoom: [0, 24] },
];

const degrees = Math.PI / 180;

function framesOf(scene: Scene): TileGridFrameInput[] {
  const settings = ImmersiveMapSettings.default;
  const cameraSettings = { camera: settings.camera, presentation: settings.presentation };
  const resolver = new FrameCameraStateResolver(cameraSettings);
  const frames: TileGridFrameInput[] = [];
  for (let i = 0; i < FRAMES; i++) {
    // A pan of a few pixels a frame.
    const centre = ImmersiveMapProjection.worldMercator(scene.latitude * degrees, (scene.longitude + (i * 0.0004) / 2 ** Math.max(scene.zoom - 13, 0)) * degrees);
    const state = ImmersiveMapCameraState.make(centre, scene.zoom, scene.bearing * degrees, scene.pitch * degrees);
    resolver.setCameraState(state);
    const presentation = PresentationStateResolver.resolve(state, settings.presentation, null);
    const frame = resolver.makeFrameState(WIDTH, HEIGHT, presentation.presentationState.transition);
    if (frame === null) throw new Error("no camera frame");
    const input = tileGridFrameOf(presentation, frame);
    // The camera's arrays are rewritten by the next frame: the copies are this frame's.
    frames.push({ ...input, projectionView: new Float64Array(input.projectionView), cameraEye: [...input.cameraEye] as [number, number, number] });
  }
  return frames;
}

/** Microseconds a frame, over batches of every frame of the scene. */
function time(run: (frame: number) => void): { median: number; p95: number } {
  const samples: number[] = [];
  for (let batch = 0; batch < WARMUP + BATCHES; batch++) {
    const start = performance.now();
    for (let i = 0; i < FRAMES; i++) run(i);
    const elapsed = performance.now() - start;
    if (batch >= WARMUP) samples.push((elapsed * 1000) / FRAMES);
  }
  const { median, p95 } = stat(samples);
  return { median, p95 };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function run(): Promise<void> {
  await initFrameWasm();
  const atlasSource = (await (await fetch(new URL("../../../../packages/immersive-map/assets/atlas.json", import.meta.url))).json()) as TileGridAtlasSource;
  const atlas = makeTileGridAtlas(atlasSource);
  const rows: (string | number)[][] = [];
  const raw: unknown[] = [];

  for (const scene of scenes) {
    const frames = framesOf(scene);
    const settings: TileGridSettings = tileGridSettings({ zoomRange: scene.gridZoom });
    const noLabels: TileGridSettings = tileGridSettings({ zoomRange: scene.gridZoom, labelMinimumTileScreenPoints: 1e9 });
    const viewportHeightPoints = HEIGHT / PIXELS_PER_POINT;

    // The selection: every third tile of the first frame's grid, and a few hundred tiles elsewhere and of other zooms.
    const probe = new TileGridFrame(atlas);
    const empty = new ImmersiveMapTileGridController();
    probe.resolve(frames[0]!, settings, empty, viewportHeightPoints);
    const gridZoom = probe.zoom ?? 0;
    const numbers = probe.tileNumbers().slice();
    const controller = new ImmersiveMapTileGridController();
    const selection = [];
    for (let i = 0; i < numbers.length; i += 12) selection.push({ zoom: numbers[i]!, x: numbers[i + 1]!, y: numbers[i + 2]! });
    for (let i = 0; i < 300; i++) selection.push({ zoom: gridZoom, x: (i * 7919) % 2 ** gridZoom, y: (i * 104729) % 2 ** gridZoom });
    controller.select(selection);
    probe.destroy();

    const wasm = new TileGridFrame(atlas);
    const wasmTiles = new TileGridFrame(atlas);

    // The texts, laid out once for either TypeScript variant.
    const layouts = new Map<number, TsLayout | undefined>();
    const layoutOf = (z: number, x: number, y: number): TsLayout | undefined => {
      const key = tileNumber(z, x, y);
      if (layouts.has(key)) return layouts.get(key);
      // Single precision, as the Rust frame computes the share.
      const layout = layOutTileGridText(atlas, `${z}/${x}/${y}`);
      const made = layout === undefined ? undefined : { share: Math.min(Math.fround(Math.fround(settings.labelMaximumWidthShare) / Math.fround(layout.widthEm)), Math.fround(Math.fround(settings.labelMaximumHeightShare) / Math.fround(layout.heightEm))), records: layout.records };
      layouts.set(key, made);
      return made;
    };
    let glyphs = new Uint32Array(4 * 16 * 1024);
    let glyphFloats = new Float32Array(glyphs.buffer);
    let glyphWords = 0;
    const tsGlyphs = (): void => {
      const count = wasmTiles.plainCount + wasmTiles.selectedCount;
      const tiles = wasmTiles.tileNumbers();
      glyphWords = 0;
      for (let i = 0; i < count; i++) {
        const layout = layoutOf(tiles[i * 4]!, tiles[i * 4 + 1]!, tiles[i * 4 + 2]!);
        if (layout === undefined) continue;
        const records = layout.records;
        if (glyphs.length < glyphWords + records.length) {
          const grown = new Uint32Array((glyphWords + records.length) * 2);
          grown.set(glyphs.subarray(0, glyphWords));
          glyphs = grown;
          glyphFloats = new Float32Array(grown.buffer);
        }
        glyphs.set(records, glyphWords);
        for (let g = glyphWords; g < glyphWords + records.length; g += 4) {
          glyphs[g] = glyphs[g]! | i;
          glyphFloats[g + 3] = layout.share;
        }
        glyphWords += records.length;
      }
    };

    const selected = new Set<number>(controller.selectedTiles.map((tile) => tileNumber(tile.zoom, tile.x, tile.y)));
    const ts = new TsTileGrid(selected, layoutOf);
    const isFlat = frames[0]!.renderSurfaceMode === "flat";
    const tsInput = (frame: TileGridFrameInput) => ({
      polygon: new TsPolygon(coverageFootprint(frame.projectionView as Float64Array)),
      panX: frame.flatRenderState.pan[0],
      panY: frame.flatRenderState.pan[1],
      renderMapSize: frame.flatRenderState.renderMapSize,
      centreX: frame.centerWorldMercator[0],
      centreY: frame.centerWorldMercator[1],
      zoom: gridZoom,
      limit: settings.maximumDrawnTiles,
    });

    // The variants agree before they are timed.
    wasm.resolve(frames[0]!, settings, controller, viewportHeightPoints);
    const drawsLabels = wasm.drawsLabels;
    const wasmInstances = wasm.instanceBytes();
    const wasmGlyphs = wasm.glyphBytes();
    const reference = { tiles: wasm.tileCount, grid: wasm.plainCount + wasm.selectedCount, glyphs: wasm.glyphCount };
    const referenceInstances = new Uint8Array(wasmInstances.buffer, wasmInstances.byteOffset, reference.grid * 32).slice();
    const referenceGlyphs = new Uint8Array(wasmGlyphs.buffer, wasmGlyphs.byteOffset, wasmGlyphs.byteLength).slice();
    wasmTiles.resolve(frames[0]!, noLabels, controller, viewportHeightPoints);
    if (drawsLabels) tsGlyphs();
    if (!sameBytes(referenceGlyphs, new Uint8Array(glyphs.buffer, 0, glyphWords * 4))) throw new Error(`${scene.name}: the glyphs put together in TypeScript differ`);
    if (isFlat) {
      ts.resolve(tsInput(frames[0]!), drawsLabels);
      // The flags' bits above the first eight carry the subdivision, which the plane leaves zero.
      if (!sameBytes(referenceInstances, new Uint8Array(ts.instances, 0, ts.tileCount * 32))) throw new Error(`${scene.name}: the tiles of the TypeScript frame differ`);
      if (!sameBytes(referenceGlyphs, new Uint8Array(ts.glyphs.buffer, 0, ts.glyphCount * 16))) throw new Error(`${scene.name}: the glyphs of the TypeScript frame differ`);
    }

    // Interleaved, three rounds, the median of the rounds' medians.
    const results: Record<string, { median: number; p95: number }[]> = { wasm: [], wasmTsGlyphs: [], ts: [] };
    for (let round = 0; round < 3; round++) {
      results.wasm!.push(time((i) => void wasm.resolve(frames[i]!, settings, controller, viewportHeightPoints)));
      results.wasmTsGlyphs!.push(
        time((i) => {
          wasmTiles.resolve(frames[i]!, noLabels, controller, viewportHeightPoints);
          if (drawsLabels) tsGlyphs();
        }),
      );
      if (isFlat) results.ts!.push(time((i) => ts.resolve(tsInput(frames[i]!), drawsLabels)));
    }
    const middle = (values: { median: number; p95: number }[]): { median: number; p95: number } | undefined => [...values].sort((a, b) => a.median - b.median)[Math.floor(values.length / 2)];
    const w = middle(results.wasm!)!;
    const g = middle(results.wasmTsGlyphs!)!;
    const t = middle(results.ts!);
    rows.push([scene.name, reference.tiles, reference.glyphs, w.median, w.p95, g.median, g.p95, t?.median ?? "—", t?.p95 ?? "—"]);
    raw.push({ scene, reference, results });
    wasm.destroy();
    wasmTiles.destroy();
  }
  publish(
    "B23: the tile grid's frame, microseconds a frame",
    ["сцена", "тайлов", "глифов", "Rust/Wasm, мкс", "p95", "Rust/Wasm + глифы на TS, мкс", "p95", "TypeScript, мкс", "p95"],
    rows,
    raw,
  );
  done();
}

run().catch(fail);
