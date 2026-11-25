// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, test, type Page } from "@playwright/test";

const ARCHIVE = "/fixtures/fixtures.pmtiles";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  return errors;
}

/** Keeps the grid's side of the last frame in `window.gridFrame`. */
async function watchGridFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).map.onFrame((event: { drawnTileGridTiles: number }) => {
      (window as any).gridFrame = { tiles: event.drawnTileGridTiles };
    });
    (window as any).map.requestFrame();
  });
}

const selected = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).tileGrid.selectedTiles.map((window as any).ImmersiveMapTileID.key).sort());

test("the tile grid draws on the flat map, and a tap selects the tile under it and a second one takes it back", async ({ page }) => {
  const errors = collectErrors(page);
  // The zoom 15 tiles over central Moscow, a tap acting at once.
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=13.2&grid=1&gridZoom=15&gridDoubleTapZoom=0`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  await watchGridFrames(page);
  await page.waitForFunction(() => (window as any).gridFrame?.tiles >= 12, null, { timeout: 30_000 });
  const box = (await page.locator("#map canvas").boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // The camera looks at the tile that holds its centre.
  const under = await page.evaluate(() => {
    const { map, ImmersiveMapTileID } = window as any;
    return ImmersiveMapTileID.key(ImmersiveMapTileID.containing({ latitude: map.view.center[1], longitude: map.view.center[0] }, 15));
  });
  await page.mouse.click(centre.x, centre.y);
  expect(await selected(page)).toEqual([under]);
  await page.mouse.click(centre.x - 300, centre.y - 200);
  expect((await selected(page)).length).toBe(2);
  await page.mouse.click(centre.x, centre.y);
  expect(await selected(page)).not.toContain(under);
  const events = await page.evaluate(() => (window as any).tileGridEvents);
  expect(events.map((event: { kind: string; source: string }) => [event.kind, event.source])).toEqual([
    ["selection", "tap"],
    ["selection", "tap"],
    ["selection", "tap"],
  ]);
  // A drag is no tap.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y + 40, { steps: 6 });
  await page.mouse.up();
  expect((await selected(page)).length).toBe(1);
  // Detached, the map shows no grid.
  await page.evaluate(() => {
    (window as any).map.tileGrid = null;
    (window as any).map.requestFrame();
  });
  await page.waitForFunction(() => (window as any).gridFrame?.tiles === 0, null, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("a grid handed to the map as it is built is drawn by its first frames", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=13.2&grid=1&gridAtCreate=1&gridZoom=15&gridSelect=15/19808/10243`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  await watchGridFrames(page);
  await page.waitForFunction(() => (window as any).gridFrame?.tiles >= 12, null, { timeout: 30_000 });
  expect(await selected(page)).toEqual(["15/19808/10243"]);
  expect(errors).toEqual([]);
});

test("the tile grid draws on the globe and through the unroll with no error, and the double tap can be its gesture", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=2.6&grid=1&gridGesture=doubleTap&gridSelect=2/2/1,4/9/5`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  await watchGridFrames(page);
  await page.waitForFunction(() => (window as any).gridFrame?.tiles >= 2, null, { timeout: 30_000 });
  const box = (await page.locator("#map canvas").boundingBox())!;
  const zoom = await page.evaluate(() => (window as any).map.view.zoom);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => (window as any).tileGridEvents.length >= 1, null, { timeout: 5_000 });
  // The double tap is the grid's: the map did not zoom.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).map.view.zoom)).toBe(zoom);
  // Through the unroll.
  await page.evaluate(() => {
    (window as any).map.view = { zoom: 5.6 };
  });
  await page.waitForFunction(() => (window as any).gridFrame?.tiles >= 1, null, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
