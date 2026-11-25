// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Saves the views of the Swift engine's README (Tools/ReadmeFrames/frames.json
// in the reference repo) from the e2e app, for a person to compare with
// the reference's Assets/*.avif. Not a test: it streams the public archive.
//   npm run dev -w e2e-app      (in another terminal)
//   node scripts/screenshots.mjs stage-1 [--only manhattan] [--base http://localhost:5173]
// Each view is 2400 x 1720 pixels at 2 pixels per point, as the reference renders it.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const stage = args[0] ?? "stage-1";
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = option("base", "http://localhost:5173");
const only = option("only", undefined);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frames = JSON.parse(await readFile(join(root, "../ImmersiveMap/Tools/ReadmeFrames/frames.json"), "utf8"));
// Into fixtures/ (git-ignored): the README's pictures are encoded from these into Assets/.
const out = join(root, "fixtures/screenshots", stage);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-gpu", "--enable-unsafe-webgpu"],
});
for (const frame of frames) {
  if (only && !frame.name.includes(only)) continue;
  const context = await browser.newContext({ viewport: { width: (frame.width ?? 2400) / 2, height: (frame.height ?? 1720) / 2 }, deviceScaleFactor: 2 });
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(e.message));
  const query = new URLSearchParams({
    lat: String(frame.latitude ?? 0),
    lon: String(frame.longitude ?? 0),
    zoom: String(frame.zoom ?? 2),
    pitch: String(frame.pitch ?? 0),
    bearing: String(frame.bearing ?? 0),
    hud: "0",
    // The reference renders every view with the ground relief on (Tools/ReadmeFrames).
    relief: "1",
    ...(frame.theme === "night" ? { night: "1" } : {}),
    // The map draws no building models by default:
    // the views made for the models name the hosted archive.
    ...(/kremlin|bolshoi|scene-models/.test(frame.name) ? { modelArchive: "hosted" } : {}),
  });
  await tab.goto(`${base}/?${query}`);
  // The views with pins (the avatars over Shibuya and on the globe) set them
  // as the reference does, with their remote pictures, then wait for every
  // picture to arrive (a failed one keeps the placeholder).
  if (frame.pins?.length) {
    // The avatars' host sends no CORS headers, and the GPU takes no
    // cross-origin picture without them: the tool adds them to its own
    // copies of the responses (the engine loads the remote URLs as an app's
    // pins would).
    await tab.route(/^https:\/\/i\.pravatar\.cc\//, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } });
    });
    await tab.waitForFunction(() => window.map !== undefined && window.ImmersiveMapPin !== undefined, null, { timeout: 60_000 });
    await tab.evaluate((pins) => {
      window.map.pins.set(pins.map((pin) => window.ImmersiveMapPin.remote(pin.id, pin.latitude, pin.longitude, pin.image)));
    }, frame.pins);
    await tab
      .waitForFunction((ids) => ids.every((id) => window.map.pins.pin(id)?.image !== null), frame.pins.map((pin) => pin.id), { timeout: 30_000, polling: 250 })
      .catch(() => console.log(`${frame.name}: not every pin picture arrived, the placeholder stands in`));
  }
  // The views with scene models (a model by the Eiffel Tower) set them as the
  // reference does. The reference's USDZ files have glTF or OBJ copies in the
  // e2e app's public/models (a browser reads no USDZ), under the same name.
  if (frame.sceneModels?.length) {
    await tab.waitForFunction(() => window.map !== undefined && window.ImmersiveMapSceneModel !== undefined, null, { timeout: 60_000 });
    await tab.evaluate((models) => {
      window.map.sceneModels.set(
        models.map((model) =>
          window.ImmersiveMapSceneModel.make({
            id: model.id,
            source: `/models/${model.model.split("/").pop().replace(/\.usdz$/, ".obj")}`,
            coordinate: { latitude: model.latitude, longitude: model.longitude },
            altitudeMeters: model.altitudeMeters ?? 0,
            headingDegrees: model.headingDegrees ?? 0,
            pitchDegrees: model.pitchDegrees ?? 0,
            rollDegrees: model.rollDegrees ?? 0,
            scale: model.scale ?? 1,
            fitDiameterMeters: model.fitDiameterMeters ?? null,
          }),
        ),
      );
    }, frame.sceneModels);
  }
  // Settled: tiles visible, none loading (the terrain the relief waits for and the models included), and no frame drawn for a second.
  await tab.waitForFunction(
    () => {
      const s = window.mapSettle;
      return s !== undefined && s.visible > 0 && s.loading === 0 && performance.now() - s.lastFrame > 1000;
    },
    null,
    { timeout: 120_000, polling: 250 },
  ).catch(() => console.log(`${frame.name}: did not settle in two minutes, saved as it was`));
  await tab.locator("#map canvas").screenshot({ path: join(out, `${frame.name}.png`) });
  console.log(`${frame.name}${errors.length ? `  errors: ${errors.join("; ")}` : ""}`);
  await context.close();
}
await browser.close();
