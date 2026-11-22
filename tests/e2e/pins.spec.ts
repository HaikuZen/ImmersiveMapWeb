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

test("the sample pins are drawn, and a tap on one reports it and selects it", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=14.2&pins=1`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  // The frames drew pins: the selection's snapshot holds what the last frame drew.
  await page.waitForFunction(() => ((window as any).map.renderer.pinsRenderer.selectionSnapshot.entries.length as number) >= 10, null, { timeout: 15_000 });
  // The centre of the first ring pin's quad, in CSS pixels of the page.
  const target = await page.evaluate(() => {
    const map = (window as any).map;
    const snapshot = map.renderer.pinsRenderer.selectionSnapshot;
    const entry = snapshot.entries.find((e: { pinID: number }) => e.pinID >= 1 && e.pinID <= 12);
    const canvas: HTMLCanvasElement = map.canvas;
    const scale = canvas.width / canvas.clientWidth;
    const rect = canvas.getBoundingClientRect();
    const x = (entry.minX + entry.maxX) / 2;
    const y = (entry.minY + entry.maxY) / 2;
    return { id: entry.pinID as number, x: rect.left + x / scale, y: rect.top + (snapshot.drawHeight - y) / scale };
  });
  await page.mouse.click(target.x, target.y);
  // A single tap is reported once no second one follows.
  await page.waitForFunction(() => (window as any).samplePinEvents.taps === 1, null, { timeout: 5_000 });
  const state = await page.evaluate((id) => {
    const map = (window as any).map;
    return { selections: (window as any).samplePinEvents.selections, selected: map.selection.currentSelection(), isSelected: map.pins.pin(id).isSelected };
  }, target.id);
  expect(state).toEqual({ selections: 1, selected: { kind: "pin", objectID: target.id }, isSelected: true });
  expect(errors).toEqual([]);
});

test("pins and an app layer draw together on the flat map and on the globe", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=14.2&pins=1&layers=1`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  await page.evaluate(() => {
    (window as any).map.onFrame((e: { drawnAppLayers: number; pendingLayerMeshes: number }) => {
      (window as any).combinedFrame = { drawnAppLayers: e.drawnAppLayers, pendingLayerMeshes: e.pendingLayerMeshes, pins: (window as any).map.renderer.pinsRenderer.selectionSnapshot.entries.length };
    });
    (window as any).map.requestFrame();
  });
  await page.waitForFunction(() => { const f = (window as any).combinedFrame; return f !== undefined && f.drawnAppLayers > 0 && f.pendingLayerMeshes === 0 && f.pins >= 10; }, null, { timeout: 30_000 });
  // On the globe both follow the sphere: the pins over Moscow stay on its visible side.
  await page.evaluate(() => {
    (window as any).map.view = { zoom: 3 };
  });
  await page.waitForFunction(() => { const f = (window as any).combinedFrame; return f.drawnAppLayers > 0 && f.pins >= 1; }, null, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
