// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B23, the GPU half: the frame's GPU time on the live map without the tile
// grid, with every tile of the grid drawn as a whole patch (the Swift
// engine's way) and with the tiles that are not selected drawn as the frame
// of their border (docs/benchmarks/B23-tile-grid.md). The playground at
// 2400 by 1720 device pixels, the variants in turn, three rounds.
//   node scripts/bench-tile-grid-gpu.mjs [--base http://localhost:5173]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:5173";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = 240;
const ROUNDS = 3;

const scenes = [
  { name: "сверху, z13.2, сетка z15", query: "zoom=13.2&gridZoom=15" },
  { name: "сверху, z14.3, сетка z15 (крупные тайлы)", query: "zoom=14.3&gridZoom=15" },
  { name: "наклон 62°, z14.2, сетка z15", query: "zoom=14.2&pitch=62&bearing=30&gridZoom=15" },
  { name: "к горизонту, z15.5, сетка z16 (512 тайлов)", query: "zoom=15.5&pitch=80&bearing=30&gridZoom=16" },
  { name: "сверху, z12.7, сетка z15 без подписей (мелкие тайлы)", query: "zoom=12.7&gridZoom=15" },
  { name: "глобус, z2.6", query: "zoom=2.6&lon=20&lat=40" },
];

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-gpu", "--enable-unsafe-webgpu"],
});
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const scene of scenes) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`${base}/?hud=0&grid=1&${scene.query}`);
  await page.waitForFunction(() => window.mapSettle && window.mapSettle.visible > 0 && window.mapSettle.loading === 0 && performance.now() - window.mapSettle.lastFrame > 1000, null, { timeout: 60000 });
  const samples = { none: [], patches: [], frames: [] };
  let tiles = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const variant of ["none", "patches", "frames"]) {
      const run = await page.evaluate(
        async ({ variant, frames }) => {
          const map = window.map;
          const grid = window.tileGrid;
          map.tileGrid = variant === "none" ? null : grid;
          // The measurement's switch: the pipeline of the map's renderer.
          map.renderer.tileGridRuntime.pipeline.drawsFrames = variant === "frames";
          const gpu = [];
          let tiles = 0;
          let seen = 0;
          await new Promise((resolve) => {
            const stop = map.onFrame((event) => {
              seen++;
              tiles = event.drawnTileGridTiles;
              // The GPU's time is read a few frames late: the first ones are the variant before.
              if (seen > 30 && event.gpuMilliseconds !== undefined) gpu.push(event.gpuMilliseconds);
              if (seen >= frames) {
                stop();
                resolve();
              } else requestAnimationFrame(() => map.requestFrame());
            });
            map.requestFrame();
          });
          return { gpu, tiles };
        },
        { variant, frames: FRAMES },
      );
      samples[variant].push(median(run.gpu));
      if (variant !== "none") tiles = run.tiles;
    }
  }
  const row = { scene: scene.name, tiles, none: median(samples.none), patches: median(samples.patches), frames: median(samples.frames), rounds: samples };
  results.push(row);
  console.log(`| ${row.scene} | ${row.tiles} | ${row.none.toFixed(2)} | ${row.patches.toFixed(2)} | ${row.frames.toFixed(2)} | ${(row.patches - row.none).toFixed(2)} | ${(row.frames - row.none).toFixed(2)} |`);
  await page.close();
}
await browser.close();
await mkdir(join(root, "docs/benchmarks/raw"), { recursive: true });
const file = join(root, `docs/benchmarks/raw/bench-tile-grid-gpu-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
await writeFile(file, JSON.stringify(results, null, 2));
console.log(`saved ${file}`);
