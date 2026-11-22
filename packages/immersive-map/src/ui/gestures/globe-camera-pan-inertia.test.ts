// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { GlobeCameraPanInertia, GlobeCameraPanInertiaConfiguration } from "./globe-camera-pan-inertia.ts";

const configuration = (isEnabled = true): GlobeCameraPanInertiaConfiguration => new GlobeCameraPanInertiaConfiguration(isEnabled, 0.28, 450, 60, 7000);

describe("GlobeCameraPanInertia", () => {
  test("a slow release does not start it", () => {
    const inertia = new GlobeCameraPanInertia(configuration());
    expect(inertia.start([100, 0], 0)).toBe(false);
    expect(inertia.active).toBe(false);
  });

  test("a fast release glides, decays and stops", () => {
    const inertia = new GlobeCameraPanInertia(configuration());
    expect(inertia.start([1000, 0], 0)).toBe(true);
    const first = inertia.advance(1 / 60);
    expect(first.translation[0]).toBeCloseTo(1000 / 60, 6);
    let time = 1 / 60;
    let travelled = first.translation[0];
    let frames = 0;
    while (inertia.active && frames < 600) {
      time += 1 / 60;
      travelled += inertia.advance(time).translation[0];
      frames += 1;
    }
    expect(inertia.active).toBe(false);
    expect(frames).toBeLessThan(120);
    // The integral of the decaying velocity, a bit under v halfLife / ln 2.
    expect(travelled).toBeLessThan((1000 * 0.28) / Math.LN2);
    expect(travelled).toBeGreaterThan(300);
  });

  test("the initial velocity is capped", () => {
    const inertia = new GlobeCameraPanInertia(configuration());
    inertia.start([0, 70_000], 0);
    expect(inertia.advance(0.01).translation[1]).toBeCloseTo(70, 6);
  });

  test("disabling it cancels it", () => {
    const inertia = new GlobeCameraPanInertia(configuration());
    inertia.start([1000, 0], 0);
    expect(inertia.updateConfiguration(configuration(false))).toBe(false);
    expect(inertia.start([1000, 0], 0)).toBe(false);
  });
});
