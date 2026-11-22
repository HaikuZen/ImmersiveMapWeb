// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The settings are plain data: they cross to a worker by structured clone
// and to disk by JSON, and come back equal. No Swift counterpart: the Swift
// value never leaves its process.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { PinShape } from "./pin-shape.ts";
import { planSettingsApplication } from "./settings-application-planner.ts";

const tuned = ImmersiveMapSettings.default
  .night()
  .shadows({ strength: 0.6 })
  .groundRelief({ isEnabled: true })
  .modelArchiveSettings({ depthBias: { 14: 0.08, 15.5: 0.01 } })
  .pinSettings({ shape: PinShape.roundedRectangle(0.2, true) })
  .cameraBounds({ southWest: { latitude: 55.57, longitude: 37.36 }, northEast: { latitude: 55.92, longitude: 37.86 } });

describe("the settings as plain data", () => {
  test("a structured clone of the data is the same settings", () => {
    const clone = structuredClone(tuned.data);
    expect(ImmersiveMapSettings.from(clone).equals(tuned)).toBe(true);
    expect(planSettingsApplication(tuned, clone).actions.size).toBe(0);
  });

  test("the JSON of the settings is the same settings", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(tuned));
    expect(parsed).toEqual(structuredClone(tuned.data));
    expect(ImmersiveMapSettings.default.equals(ImmersiveMapSettings.default.edit(() => {}))).toBe(true);
  });

  test("the settings are frozen through", () => {
    expect(Object.isFrozen(tuned)).toBe(true);
    expect(Object.isFrozen(tuned.data.scene.shadows.strength)).toBe(true);
    expect(Object.isFrozen(tuned.data.mapStyle.theme.layers.water)).toBe(true);
    expect(() => {
      (tuned.data.scene.shadows as { isEnabled: boolean }).isEnabled = false;
    }).toThrow(TypeError);
  });

  test("a modifier leaves the settings it came from untouched", () => {
    const before = structuredClone(ImmersiveMapSettings.default.data);
    ImmersiveMapSettings.default.shadows({ isEnabled: false }).night().trees({ isEnabled: false });
    expect(ImmersiveMapSettings.default.data).toEqual(before);
  });
});
