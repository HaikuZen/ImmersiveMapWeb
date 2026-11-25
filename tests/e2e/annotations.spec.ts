// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, type Page, test } from "@playwright/test";

const ARCHIVE = "/fixtures/fixtures.pmtiles";

/** Collects the page's errors and warnings, as the map e2e tests count them. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  return errors;
}

/** Opens the e2e app at a view and waits for a frame drawn after its first tiles landed. */
async function openAndDraw(page: Page, view: string): Promise<void> {
  await page.goto(`/?archive=${ARCHIVE}&${view}`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = (window as any).map;
        const off = map.onFrame(() => {
          off();
          resolve();
        });
        map.requestFrame();
      }),
  );
}

/** The badge's words, link and target, read off its element. */
function readBadge(page: Page) {
  return page.evaluate(() => {
    const badge = document.querySelector<HTMLAnchorElement>("[data-immersive-map-attribution]");
    return badge === null ? null : { text: badge.textContent, href: badge.getAttribute("href"), target: badge.target, rel: badge.rel, display: badge.style.display };
  });
}

test("the attribution badge credits the data at the camera's zoom", async ({ page }) => {
  const errors = collectErrors(page);
  await openAndDraw(page, "lon=37.6175&lat=55.752&zoom=14.2");
  // Past the overview's zooms its biomes' credit has left the line.
  expect(await readBadge(page)).toEqual({
    text: "Powered by ImmersiveMap · © OpenStreetMap",
    href: "https://www.openstreetmap.org/copyright",
    target: "_blank",
    rel: "noopener",
    display: "block",
  });
  // Zoomed out to the globe, the overview's credit joins the line.
  await page.evaluate(() => {
    (window as any).map.view = { zoom: 3 };
  });
  await page.waitForFunction(() => document.querySelector("[data-immersive-map-attribution]")?.textContent?.includes("Biomes © RESOLVE, CC BY 4.0"), null, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("the annotations stand on their coordinates and take their own presses", async ({ page }) => {
  const errors = collectErrors(page);
  await openAndDraw(page, "lon=37.6175&lat=55.752&zoom=14.2&annotations=1");
  // Every annotation's box was moved by a frame: a transform set and shown.
  await page.waitForFunction(
    () => {
      const boxes = [...document.querySelectorAll<HTMLElement>("[data-immersive-map-annotation]")];
      return boxes.length === 3 && boxes.every((box) => box.style.transform.startsWith("translate3d(") && box.style.visibility === "");
    },
    null,
    { timeout: 10_000 },
  );
  const overlay = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("[data-immersive-map-annotations]");
    const ids = [...document.querySelectorAll<HTMLElement>("[data-sample-annotation]")].map((node) => node.dataset.sampleAnnotation);
    return { pointerEvents: element?.style.pointerEvents, ids, nextIsBadge: element?.nextElementSibling?.hasAttribute("data-immersive-map-attribution") };
  });
  // The overlay lets presses through to the map, sits under the badge, and keeps the items' order.
  expect(overlay).toEqual({ pointerEvents: "none", ids: ["kremlin", "red-square", "alexander-garden"], nextIsBadge: true });
  await page.click("button[data-sample-annotation=alexander-garden]");
  expect(await page.evaluate(() => (window as any).annotationPresses.count)).toBe(1);
  expect(errors).toEqual([]);
});
