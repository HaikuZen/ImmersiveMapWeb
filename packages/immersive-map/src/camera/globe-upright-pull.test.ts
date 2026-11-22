// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultCameraSettings, type GlobeUprightPullSettings, globeUprightPull } from "../configuration/camera-settings.ts";
import { CameraBearingConstraint, type CameraConstraints, CameraPitchConstraint } from "./camera-constraint-resolver.ts";
import { GlobeUprightPull, type GlobeUprightWindow } from "./globe-upright-pull.ts";
import type { ViewMode } from "./view-mode.ts";

describe("GlobeUprightPull", () => {
  const constraints: CameraConstraints = {
    bearing: new CameraBearingConstraint(null),
    pitch: new CameraPitchConstraint(0, 1.2),
  };

  function window(
    zoom: number,
    settings: GlobeUprightPullSettings | null = globeUprightPull(),
    renderSurfaceMode: ViewMode = "spherical",
    customConstraints: CameraConstraints = constraints,
  ): GlobeUprightWindow | null {
    return GlobeUprightPull.window(zoom, settings, renderSurfaceMode, customConstraints);
  }

  test("the pull is on by default", () => {
    expect(defaultCameraSettings.globeUprightPull).toEqual(globeUprightPull());
  });

  test("the window is upright at the lower bound and below it", () => {
    expect(window(3)).toEqual({ maximumAbsoluteBearing: 0, maximumPitch: 0 });
    expect(window(0)).toEqual({ maximumAbsoluteBearing: 0, maximumPitch: 0 });
  });

  test("the window opens linearly across the zoom range", () => {
    const opened = window(4.5);
    expect(opened).not.toBeNull();
    expect(opened!.maximumAbsoluteBearing).toBeCloseTo(Math.PI / 2, 4);
    expect(opened!.maximumPitch).toBeCloseTo(0.6, 4);
  });

  test("nothing is held from the upper bound on, on the flat map, or with the pull off", () => {
    expect(window(6)).toBeNull();
    expect(window(12)).toBeNull();
    expect(window(2, globeUprightPull(), "flat")).toBeNull();
    expect(window(2, null)).toBeNull();
  });

  test("the window closes onto the pitch floor and opens to the bearing cap", () => {
    const capped: CameraConstraints = { bearing: new CameraBearingConstraint(1), pitch: new CameraPitchConstraint(0.2, 1.2) };

    const closed = window(3, globeUprightPull(), "spherical", capped);
    expect(closed!.maximumPitch).toBeCloseTo(0.2, 4);

    const halfOpen = window(4.5, globeUprightPull(), "spherical", capped);
    expect(halfOpen!.maximumAbsoluteBearing).toBeCloseTo(0.5, 4);
    expect(halfOpen!.maximumPitch).toBeCloseTo(0.7, 4);
  });

  test("an empty zoom range switches at its zoom", () => {
    const settings = globeUprightPull({ zoomRange: { lowerBound: 4, upperBound: 4 } });
    expect(window(3.9, settings)).toEqual({ maximumAbsoluteBearing: 0, maximumPitch: 0 });
    expect(window(4, settings)).toBeNull();
  });

  test("angles inside the window are left as they came", () => {
    const step = GlobeUprightPull.step(-0.3, 0.4, { maximumAbsoluteBearing: 0.5, maximumPitch: 0.6 }, 0.016, 0.2);
    expect(step).toEqual({ bearing: -0.3, pitch: 0.4, isPulling: false });
  });

  test("the excess halves every half-life", () => {
    const step = GlobeUprightPull.step(-1.5, 1.0, { maximumAbsoluteBearing: 0.5, maximumPitch: 0.6 }, 0.2, 0.2);
    expect(step.bearing).toBeCloseTo(-1.0, 4);
    expect(step.pitch).toBeCloseTo(0.8, 4);
    expect(step.isPulling).toBe(true);
  });

  test("the first frame moves nothing and keeps pulling", () => {
    const step = GlobeUprightPull.step(1, 0.5, { maximumAbsoluteBearing: 0, maximumPitch: 0 }, 0, 0.2);
    expect(step.bearing).toBeCloseTo(1, 12);
    expect(step.pitch).toBe(0.5);
    expect(step.isPulling).toBe(true);
  });

  test("an angle close to the window lands on it", () => {
    const step = GlobeUprightPull.step(0.0002, 0.0001, { maximumAbsoluteBearing: 0, maximumPitch: 0 }, 0.016, 0.2);
    expect(step).toEqual({ bearing: 0, pitch: 0, isPulling: false });
  });

  test("a zero half-life straightens at once", () => {
    const step = GlobeUprightPull.step(2, 1, { maximumAbsoluteBearing: 0.5, maximumPitch: 0.25 }, 0, 0);
    expect(step).toEqual({ bearing: 0.5, pitch: 0.25, isPulling: false });
  });
});
