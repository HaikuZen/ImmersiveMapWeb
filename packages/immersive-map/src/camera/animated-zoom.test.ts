// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { AnimatedZoom } from "./animated-zoom.ts";

/** The animated zoom follows the camera's zoom over time and snaps when the camera is set outright. */
describe("AnimatedZoom", () => {
  test("the first frame takes the zoom at once", () => {
    const zoom = new AnimatedZoom();
    expect(zoom.advance(14, 1 / 60, 0.2)).toBe(14);
    expect(zoom.isSettling).toBe(false);
  });

  test("a jump closes half the way every half-life", () => {
    const zoom = new AnimatedZoom();
    zoom.advance(14, 1 / 60, 0.2);
    expect(zoom.advance(13, 0.2, 0.2)).toBeCloseTo(13.5, 9);
    expect(zoom.isSettling).toBe(true);
    expect(zoom.advance(13, 0.2, 0.2)).toBeCloseTo(13.25, 9);
    // Two half-lives in one frame close three quarters.
    expect(zoom.advance(13, 0.4, 0.2)).toBeCloseTo(13.0625, 9);
  });

  test("it settles on the zoom and stops asking", () => {
    const zoom = new AnimatedZoom();
    zoom.advance(14, 1 / 60, 0.2);
    let frames = 0;
    while (zoom.advance(13, 1 / 60, 0.2) !== 13 && frames < 600) {
      frames += 1;
    }
    expect(zoom.isSettling).toBe(false);
    expect(zoom.value).toBe(13);
    expect(frames, "It took its time").toBeGreaterThan(10);
    expect(frames, "A level settles within a few seconds").toBeLessThan(200);
  });

  test("a snap and a zero half-life take the zoom at once", () => {
    const zoom = new AnimatedZoom();
    zoom.advance(14, 1 / 60, 0.2);
    expect(zoom.advance(3, 1 / 60, 0.2, true)).toBe(3);
    expect(zoom.isSettling).toBe(false);
    expect(zoom.advance(15, 1 / 60, 0)).toBe(15);
    expect(zoom.isSettling).toBe(false);
  });

  test("a frame without time holds still", () => {
    const zoom = new AnimatedZoom();
    zoom.advance(14, 1 / 60, 0.2);
    expect(zoom.advance(13, 0, 0.2)).toBe(14);
    expect(zoom.isSettling, "Still on its way").toBe(true);
  });
});
