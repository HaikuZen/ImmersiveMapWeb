// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, type Page, test } from "@playwright/test";

// The fixture map archive, the fixture model archive (fixtures/models.pmtiles,
// the model tiles of the public archive over the Kremlin, packed by
// `cargo run -p fixture-archive`) and the playground's own glTF and OBJ
// models (`models=1`): nothing leaves the machine.
const ARCHIVE = "/fixtures/fixtures.pmtiles";
const MODELS = "/fixtures/models.pmtiles";

interface ModelFrame {
  draws: number;
  renderedTiles: number;
  pendingSceneModelMeshes: number;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  return errors;
}

/**
 * The first frame of a settled second: every frame for a second has drawn
 * map tiles, had no model tile and no app mesh on its way, and drawn the
 * app's models (their hit volumes in the frame's selection data). A single
 * quiet frame is not enough: the model tiles a frame wants follow the map
 * tiles in view, so a frame between two loads can have none in flight with
 * one more still to be asked for. The map tiles' own loading is not waited
 * on: a tile the fixture archive lacks (the globe's z6 and z7 around
 * Moscow) stays requested, as in Swift's tile store. The map is asked for
 * a frame every display frame while it waits, so an idle map keeps
 * reporting.
 */
async function settledModelFrame(page: Page, drawnModels: number): Promise<ModelFrame> {
  await page.waitForFunction(() => (window as any).map !== undefined && (window as any).tileStats?.length >= 4, null, { timeout: 30_000 });
  return page.evaluate(
    (drawn) =>
      new Promise<ModelFrame>((resolve, reject) => {
        const map = (window as any).map;
        let quietSince: number | undefined;
        let last: ModelFrame | undefined;
        let pump = 0;
        const finish = (): void => {
          off();
          cancelAnimationFrame(pump);
          clearTimeout(timeout);
        };
        const timeout = setTimeout(() => {
          finish();
          reject(new Error(`the map did not settle: ${JSON.stringify(last)}`));
        }, 45_000);
        const off = map.onFrame((e: ModelFrame) => {
          const entries = map.renderer?.models.sceneModels.selectionSnapshot?.entries.length ?? 0;
          last = { draws: e.draws, renderedTiles: e.renderedTiles, pendingSceneModelMeshes: e.pendingSceneModelMeshes };
          if (e.pendingSceneModelMeshes !== 0 || e.renderedTiles === 0 || entries < drawn) {
            quietSince = undefined;
            return;
          }
          quietSince ??= performance.now();
          if (performance.now() - quietSince < 1000) return;
          finish();
          resolve(last);
        });
        const ask = (): void => {
          map.requestFrame();
          pump = requestAnimationFrame(ask);
        };
        ask();
      }),
    drawnModels,
  );
}

test("the model tiles and the app's glTF models draw on the flat map, and a tap on a model selects it", async ({ page }) => {
  const errors = collectErrors(page);
  // The camera over the sample tower, the Kremlin's model tile around it.
  await page.goto(`/?archive=${ARCHIVE}&modelArchive=${MODELS}&lon=37.6175&lat=55.752&zoom=16.4&pitch=40&globe=0&models=1&hud=0`);
  const frame = await settledModelFrame(page, 1);
  expect(frame.pendingSceneModelMeshes).toBe(0);
  expect(frame.renderedTiles).toBeGreaterThan(0);
  expect(frame.draws).toBeGreaterThan(0);
  // The Kremlin's model tile stands in for its buildings: the frame names them.
  expect(await page.evaluate(() => (window as any).map.renderer.models.state.replacedBuildings.isEmpty)).toBe(false);
  // The tower stands at the point the camera looks at: the centre of the canvas.
  const box = (await page.locator("#map canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => (window as any).sampleSceneModelEvents?.taps >= 1, null, { timeout: 10_000 });
  const events = await page.evaluate(() => (window as any).sampleSceneModelEvents);
  expect(events.lastTapped).toBe(1);
  expect(events.selections).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => (window as any).map.selection.currentSelection())).toEqual({ kind: "sceneModel", objectID: 1 });
  expect(errors).toEqual([]);
});

test("the app's models draw on the globe and through its unroll with no error", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=6.5&models=1&hud=0`);
  const frame = await settledModelFrame(page, 0);
  expect(frame.renderedTiles).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
