// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, type Page, test } from "@playwright/test";

const ARCHIVE = "/fixtures/fixtures.pmtiles";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  return errors;
}

/** Keeps the last frame's layer counters in `window.layerFrame`, and asks for a frame. */
async function watchLayerFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as any).map;
    map.onFrame((e: { drawnAppLayers: number; pendingLayerMeshes: number; draws: number }) => {
      (window as any).layerFrame = { drawnAppLayers: e.drawnAppLayers, pendingLayerMeshes: e.pendingLayerMeshes, draws: e.draws };
    });
    map.requestFrame();
  });
}

test("the layers of the app's data draw a local GeoJSON on the flat map, and a tap on a zone reports it", async ({ page }) => {
  const errors = collectErrors(page);
  // Central Moscow: the sample's zones, lines and stations (apps/playground/public/layers/moscow.geojson).
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=14.2&layers=1`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 4, null, { timeout: 30_000 });
  await watchLayerFrames(page);
  // The document is read and the meshes built in the layers' worker, then laid on the GPU: a frame draws both layers.
  await page.waitForFunction(() => (window as any).layerFrame?.drawnAppLayers === 2 && (window as any).layerFrame?.pendingLayerMeshes === 0, null, { timeout: 30_000 });
  // The camera looks at the Kremlin: a tap in the middle of the view lands on its zone, of the layer drawn last. The
  // lines' layer leaves the zones' fill out, but the Kremlin's feature states its own fill, which wins in every layer.
  const box = (await page.locator("#map canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => ((window as any).layerTaps?.length as number) >= 1, null, { timeout: 5_000 });
  const tap = await page.evaluate(() => (window as any).layerTaps[0]);
  expect(tap).toEqual({ layer: "moscow-lines", shape: 1 });
  expect(errors).toEqual([]);
});

test("the layers of the app's data draw on the globe with no error", async ({ page }) => {
  const errors = collectErrors(page);
  // Zoom 3: the zones' layer draws on the sphere, the lines' layer is out of its zooms.
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=3&layers=1`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  await watchLayerFrames(page);
  await page.waitForFunction(() => (window as any).layerFrame?.drawnAppLayers === 1 && (window as any).layerFrame?.pendingLayerMeshes === 0, null, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
