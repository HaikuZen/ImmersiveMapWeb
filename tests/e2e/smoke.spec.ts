// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, type Page, test } from "@playwright/test";

const ARCHIVE = "/fixtures/fixtures.pmtiles";

/** Opens the playground at a view of the fixture archive and checks that a frame draws its tiles with no error. */
async function drawsWithoutError(page: Page, view: string, minimumTiles: number): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  await page.goto(`/?archive=${ARCHIVE}&${view}`);
  await page.waitForFunction((count) => (window as any).tileStats?.length >= count, minimumTiles, { timeout: 30_000 });
  // A frame asked for after the tiles landed draws them: the placements and their draws.
  const frame = await page.evaluate(
    () =>
      new Promise<{ draws: number; renderedTiles: number; visibleTiles: number }>((resolve) => {
        const map = (window as any).map;
        const off = map.onFrame((e: { draws: number; renderedTiles: number; visibleTiles: number }) => {
          off();
          resolve({ draws: e.draws, renderedTiles: e.renderedTiles, visibleTiles: e.visibleTiles });
        });
        map.requestFrame();
      }),
  );
  expect(frame.visibleTiles).toBeGreaterThan(0);
  expect(frame.renderedTiles).toBeGreaterThan(0);
  expect(frame.draws).toBeGreaterThan(0);
  expect(errors).toEqual([]);
}

test("the map draws the fixture tiles with no error", async ({ page }) => {
  await drawsWithoutError(page, "lon=37.6175&lat=55.752&zoom=14.2", 4);
});

test("the globe draws the fixture tiles with no error", async ({ page }) => {
  await drawsWithoutError(page, "lon=18.1&lat=48.1&zoom=2", 4);
});

test("the globe unrolling into the plane draws with no error", async ({ page }) => {
  await drawsWithoutError(page, "lon=2.35&lat=48.85&zoom=6.5", 1);
});

test("the buildings, their shadows and the trees draw under MSAA and FXAA with no error", async ({ page }) => {
  await drawsWithoutError(page, "lon=-74.011&lat=40.715&zoom=16.2&pitch=50&bearing=-60&globe=0&msaa=1&fxaa=1", 4);
});

test("the street view keeps the world's depth for the overlay with no error", async ({ page }) => {
  await drawsWithoutError(page, "lon=-74.011&lat=40.715&zoom=16.2&pitch=50&bearing=-60&globe=0", 4);
});

test("the ground relief rises on the fixture terrain with no error", async ({ page }) => {
  // The Zermatt fixtures: the map's tiles and the Mapterhorn terrain tiles, served locally.
  await drawsWithoutError(page, "lon=7.653&lat=45.977&zoom=12.3&pitch=55&bearing=-120&globe=0&relief=1&terrain=/fixtures/terrain/{z}-{x}-{y}.webp", 4);
  // On the terrain the map reads the country around the camera off the relief's heights: the Alps are mountains.
  await page.waitForFunction(() => (window as any).map.terrainSurroundings?.kind === "mountains", null, { timeout: 30_000 });
});
