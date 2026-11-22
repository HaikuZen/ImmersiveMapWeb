// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The TypeScript port kept for bench-pins gives the engine's (Rust/Wasm)
// layout, frame by frame through a pan, as the benchmark checks before timing.

import { describe, expect, test } from "vitest";
import { defaultPinSettings } from "../../../../packages/immersive-map/src/configuration/pin-settings.ts";
import { ImmersiveMapPin, PinImageSource } from "../../../../packages/immersive-map/src/pins/immersive-map-pin.ts";
import type { PinCollisionGeometry, PinCollisionLayout, ProjectedPin } from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-types.ts";
import { PinCollisionLayoutSolver as EngineSolver } from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-layout-solver.ts";
import { PinCollisionLayoutSolver as TsSolver } from "./ts-pin-collision-layout-solver.ts";

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const geometry: PinCollisionGeometry = { pinSizePx: 128, bodyRadiusPx: 64, circleBodyRadiusPx: 59, bodyCenterOffsetX: 0, bodyCenterOffsetY: 70 };
const image = PinImageSource.remote("https://example.invalid/pin.png");

function summary(layout: PinCollisionLayout) {
  return {
    items: layout.pinItems.map((item) => [item.pin.id, item.screenPoint.positionX, item.screenPoint.positionY, item.screenPoint.visibilityAlpha, item.displayScale, item.morph, item.isFlowerPetal]),
    flowers: layout.flowerGroups.map((group) => [group.memberIDs, group.visibleMemberIDs, group.centerX, group.centerY]),
    animating: layout.hasActiveAnimations,
  };
}

describe("the TypeScript pin solver of the benchmark", () => {
  test("matches the engine's solver through a pan with piles, event groups and selected pins", () => {
    const next = random(5);
    const pins: ProjectedPin[] = [];
    for (let i = 0; i < 400; i++) {
      // A third in piles, a tenth event pins, the rest scattered, the ids shuffled against the order.
      const piled = i % 3 === 0;
      const x = piled ? 600 + (i % 4) * 300 + (next() - 0.5) * 80 : next() * 1800;
      const y = piled ? 500 + (next() - 0.5) * 80 : next() * 1200;
      const pin = ImmersiveMapPin.make({ id: 1000 - i * 2, coordinate: { latitude: 0, longitude: 0 }, image, isSelected: i % 97 === 0, drawPriority: i % 11 === 0 ? 2 : 0, clusterPolicy: i % 10 === 1 ? "event" : "none", screenSizeScale: i % 13 === 0 ? 1.2 : 1 });
      pins.push({ pin, squashScaleX: 1, squashScaleY: 1, screenPoint: { positionX: x, positionY: y, depth: 0.5, visible: 1, visibilityAlpha: 1 }, worldX: x / 1048576, worldY: y / 1048576, drawOrder: i });
    }
    const baseX = pins.map((p) => p.screenPoint.positionX);
    const engine = new EngineSolver();
    const port = new TsSolver();
    for (let frame = 0; frame < 90; frame++) {
      const angle = (2 * Math.PI * frame) / 60;
      pins.forEach((p, i) => (p.screenPoint.positionX = baseX[i]! + Math.cos(angle) * 40));
      const time = frame / 60;
      expect(summary(port.solve(pins, geometry, defaultPinSettings, time))).toEqual(summary(engine.solve(pins, geometry, defaultPinSettings, time)));
    }
  });
});
