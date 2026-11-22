// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The camera route of docs/GOAL.md section 8, scripted: Moscow, Manhattan and
// the Alps, each reached by a jump, waited on until its tiles are in (the time
// to the first full frame), then flown for a few seconds (turning, tilting,
// zooming in and out, panning) while every frame's CPU and GPU time is kept.
// Streams the public archive. Appends one section to docs/benchmarks/progress.md.
//   npm run dev -w playground      (in another terminal)
//   node scripts/flyover.mjs "stage 1" [--base http://localhost:5173] [--seconds 8] [--relief 0]
// The ground relief is on unless `--relief 0` (an A/B of its cost).

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const label = args[0] ?? "stage";
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = option("base", "http://localhost:5173");
const seconds = Number(option("seconds", "8"));
const relief = option("relief", "1") === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const route = [
  { name: "Moscow", lon: 37.6175, lat: 55.752, zoom: 14.5, pitch: 45, bearing: 0 },
  { name: "Manhattan", lon: -74.011, lat: 40.715, zoom: 15, pitch: 50, bearing: -60 },
  { name: "Alps (Zermatt)", lon: 7.653, lat: 45.977, zoom: 12.5, pitch: 55, bearing: -120 },
];

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  // FLYOVER_CHROME_ARGS adds Chrome switches for an A/B run, for example
  // Dawn features that turn off the browser's safety checks to see their cost.
  args: ["--enable-gpu", "--enable-unsafe-webgpu", ...(process.env.FLYOVER_CHROME_ARGS ?? "").split(" ").filter(Boolean)],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, deviceScaleFactor: 2 });
const tab = await context.newPage();
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
tab.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
tab.on("crash", () => console.log(`The page crashed. Errors so far: ${errors.join("; ") || "none"}`));
const first = route[0];
// The ground relief on, as the reference's views draw it: the Alps' leg flies over it.
await tab.goto(`${base}/?lat=${first.lat}&lon=${first.lon}&zoom=${first.zoom}&pitch=${first.pitch}&bearing=${first.bearing}&hud=0${relief ? "&relief=1" : ""}`);
// `window.map` is the container element (named access) until the playground replaces it.
await tab.waitForFunction(() => window.mapSettle !== undefined, null, { timeout: 60_000 });

const results = [];
for (const place of route) {
  const result = await tab.evaluate(
    async ({ place, seconds }) => {
      const map = window.map;
      const degrees = Math.PI / 180;
      const frames = [];
      const stop = map.onFrame((e) => frames.push(e));
      const settled = () => {
        const last = frames.at(-1);
        return last !== undefined && last.visibleTiles > 0 && last.loadingTiles === 0 && last.pendingTerrainTiles === 0 && performance.now() - last.time > 500;
      };
      const stopTime = map.onFrame((e) => (e.time = performance.now()));
      // The jump, and the wait for the first full frame.
      const jumpedAt = performance.now();
      map.view = { center: [place.lon, place.lat], zoom: place.zoom, pitch: place.pitch * degrees, bearing: place.bearing * degrees };
      while (!settled() && performance.now() - jumpedAt < 60_000) await new Promise((r) => setTimeout(r, 100));
      const fullFrameAt = frames.findLast((f) => f.loadingTiles === 0 && f.pendingTerrainTiles === 0)?.time ?? performance.now();
      frames.length = 0;
      // The flight: one turn of a quarter circle, the zoom down and back up a
      // level, the pitch nodding, the centre drifting a few hundred metres.
      const start = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const t = (performance.now() - start) / 1000 / seconds;
          if (t >= 1) return resolve();
          const wave = Math.sin(t * Math.PI * 2);
          map.view = {
            center: [place.lon + 0.004 * wave, place.lat + 0.003 * Math.sin(t * Math.PI)],
            zoom: place.zoom - Math.sin(t * Math.PI),
            pitch: (place.pitch + 10 * wave) * degrees,
            bearing: (place.bearing + 90 * t) * degrees,
          };
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      stop();
      stopTime();
      return {
        firstFullFrameMs: fullFrameAt - jumpedAt,
        cpu: frames.map((f) => f.cpuMilliseconds),
        gpu: frames.flatMap((f) => (f.gpuMilliseconds === undefined ? [] : [f.gpuMilliseconds])),
        loading: frames.filter((f) => f.loadingTiles > 0).length,
      };
    },
    { place, seconds },
  );
  results.push({ place: place.name, ...result });
  console.log(`${place.name}: ${result.cpu.length} frames, first full frame ${result.firstFullFrameMs.toFixed(0)} ms`);
}
await browser.close();

const quantile = (values, q) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
const date = new Date().toISOString().slice(0, 16).replace("T", " ");
const all = { cpu: results.flatMap((r) => r.cpu), gpu: results.flatMap((r) => r.gpu) };
let section = `\n## ${label}, ${date}\n\nChrome headless (системный Chrome), 2400×1720 при 2 пикселях на точку, публичный архив, настройки по умолчанию (глобус включён)${relief ? ", рельеф включён" : ", рельеф выключен"}. ${seconds} с полёта на место.\n\n`;
section += "| место | кадров | первый полный кадр, мс | CPU медиана | CPU p95 | GPU медиана | GPU p95 | кадров с загрузкой |\n|---|---|---|---|---|---|---|---|\n";
for (const r of results) section += `| ${r.place} | ${r.cpu.length} | ${r.firstFullFrameMs.toFixed(0)} | ${f(quantile(r.cpu, 0.5))} | ${f(quantile(r.cpu, 0.95))} | ${f(quantile(r.gpu, 0.5))} | ${f(quantile(r.gpu, 0.95))} | ${r.loading} |\n`;
section += `| **всё** | ${all.cpu.length} | | ${f(quantile(all.cpu, 0.5))} | ${f(quantile(all.cpu, 0.95))} | ${f(quantile(all.gpu, 0.5))} | ${f(quantile(all.gpu, 0.95))} | |\n`;
if (errors.length) section += `\nОшибки страницы: ${errors.join("; ")}\n`;
const file = join(root, "docs/benchmarks/progress.md");
if (!existsSync(file)) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "# Производительность по этапам\n\nОблёт `scripts/flyover.mjs` (раздел 8 `docs/GOAL.md`): Москва, Манхэттен, Альпы. Регрессия больше 10% без объяснения считается ошибкой.\n");
}
await appendFile(file, section);
console.log(section);
