// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, type Page, test } from "@playwright/test";

const ARCHIVE = "/fixtures/fixtures.pmtiles";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  return errors;
}

test("a still capture settles the scene offscreen and returns a PNG of the configured size", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=15&pitch=45&pins=1&hud=0`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const map = (window as any).map;
    const viewBefore = JSON.stringify(map.view);
    const blob: Blob = await map.captureStill({ configuration: { width: 640, height: 360, pixelsPerPoint: 1, settleTimeout: 20 } });
    const bitmap = await createImageBitmap(blob);
    return {
      type: blob.type,
      bytes: blob.size,
      head: [...new Uint8Array(await blob.slice(0, 8).arrayBuffer())],
      width: bitmap.width,
      height: bitmap.height,
      // The capture draws a map of its own: the one on the page keeps its camera.
      viewKept: JSON.stringify(map.view) === viewBefore,
    };
  });
  expect(result.type).toBe("image/png");
  expect(result.head).toEqual(PNG_SIGNATURE);
  expect([result.width, result.height]).toEqual([640, 360]);
  // A drawn map, not a blank frame: a uniform 640 × 360 PNG is a few hundred bytes.
  expect(result.bytes).toBeGreaterThan(20_000);
  expect(result.viewKept).toBe(true);
  expect(errors).toEqual([]);
});

test("a short tour exports to an MP4 the browser plays at the configured size", async ({ page }) => {
  // The fixture archive lacks a few tiles the tour's far rings ask for, so a
  // frame that wants them waits its readiness timeout, kept short here.
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto(`/?archive=${ARCHIVE}&lon=37.6175&lat=55.752&zoom=15&export=1&annotations=1&hud=0`);
  await page.waitForFunction(() => (window as any).tileStats?.length >= 1 && (window as any).exportDemo !== undefined, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const last = await (window as any).exportDemo.recordTour({ framesPerSecond: 10, width: 320, height: 180, tileReadinessTimeout: 0.5 });
    const video = document.querySelector("video")!;
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 1) resolve();
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error(video.error?.message ?? "the video did not load"));
    });
    const phases = [...new Set(((window as any).exportDemo.progress as { phase: string }[]).map((p) => p.phase))];
    return { last, width: video.videoWidth, height: video.videoHeight, duration: video.duration, phases };
  });
  expect(result.last.type).toBe("video/mp4");
  // The file starts with its `ftyp` box.
  expect(String.fromCharCode(...result.last.head.slice(4, 8))).toBe("ftyp");
  expect([result.width, result.height]).toEqual([320, 180]);
  // The sample tour: 2 + 0.5 + 2 + 0.5 + 1.5 seconds, every frame at 10 per second, both ends included.
  expect(result.last.frames).toBe(66);
  expect(result.duration).toBeCloseTo(6.6, 1);
  expect(result.phases).toEqual(["preparing", "rendering", "finishing"]);
  expect(errors).toEqual([]);
});
