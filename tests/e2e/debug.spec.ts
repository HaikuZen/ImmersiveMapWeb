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

/** The next frame the map draws, asked for at once: its tile counts and draws. */
function nextFrame(page: Page): Promise<{ draws: number; renderedTiles: number }> {
  return page.evaluate(
    () =>
      new Promise<{ draws: number; renderedTiles: number }>((resolve) => {
        const map = (window as any).map;
        const off = map.onFrame((e: { draws: number; renderedTiles: number }) => {
          off();
          resolve({ draws: e.draws, renderedTiles: e.renderedTiles });
        });
        map.requestFrame();
      }),
  );
}

test("the debug panel opens, draws its overlays and applies live settings with no error", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=14.2&globe=0&debug=1`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 4, null, { timeout: 30_000 });
  const panel = page.locator(".imm-debug-hud");
  await expect(panel).toBeVisible();
  // The stats tab shows the frame's camera lines.
  await expect(panel.locator("pre").first()).toContainText("z:");

  // The tile borders and the tile grid over the map: the overlay canvas shows.
  await panel.getByText("Tile layers").locator("..").locator("input").check();
  await panel.getByText("Tile grid", { exact: true }).locator("..").locator("input").check();
  await nextFrame(page);
  await expect(page.locator(".imm-debug-overlay")).toBeVisible();

  // A control the panel drags applies live: the shadows switched off from its Shadows tab.
  await panel.getByRole("button", { name: "Shadows", exact: true }).click();
  const shadows = panel.getByText("Enabled").first().locator("..").locator("input");
  await shadows.uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).map.settings.scene.shadows.isEnabled)).toBe(false);

  // The tiles tab lists the loader's tiles.
  await panel.getByRole("button", { name: "Tiles", exact: true }).click();
  await nextFrame(page);
  await expect(panel.locator(".imm-debug-card").first()).toBeVisible();

  // The app's own settings, applied live and by rebuilding the tiles and the renderer.
  await page.evaluate(() => (window as any).map.setSettings((s: any) => s.fog({ isEnabled: false })));
  await page.evaluate(() => (window as any).map.setSettings((s: any) => s.night()));
  await page.evaluate(() => (window as any).map.setSettings((s: any) => s.msaa()));
  await page.waitForFunction(() => (window as any).map.settings.postProcessing.multisampleCount === 4, null, { timeout: 30_000 });
  // The renderer built again keeps the panel's drag and draws tiles.
  expect(await page.evaluate(() => (window as any).map.settings.scene.shadows.isEnabled)).toBe(false);
  await expect.poll(async () => (await nextFrame(page)).renderedTiles, { timeout: 30_000 }).toBeGreaterThan(0);

  // Hidden with the controls, and gone with the panel switched off.
  await page.evaluate(() => (window as any).map.setSettings((s: any) => s.controlsHidden(true)));
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});
