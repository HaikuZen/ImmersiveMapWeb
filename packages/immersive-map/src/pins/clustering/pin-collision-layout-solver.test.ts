// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `PinCollisionLayoutSolverTests`: displacement and
// shape, the two-pass scheme, the flowers, grouping hysteresis, absorption,
// merging and the locality of clusters, run against the engine's solver.

import { describe, expect, test } from "vitest";
import { defaultPinSettings } from "../../configuration/pin-settings.ts";
import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import { ImmersiveMapPin, PinImageSource } from "../immersive-map-pin.ts";
import type { PinClusterPolicy } from "../immersive-map-pin.ts";
import { displacedCircleScale, flowerCompactnessLimitScale, flowerRingRadius, maxFlowerPetals } from "./pin-collision-math.ts";
import { PinCollisionGeometry, PinCollisionLayout, projectedPinFromScreen } from "./pin-collision-types.ts";
import type { PinCollisionItem, ProjectedPin } from "./pin-collision-types.ts";
import { PinCollisionLayoutSolver } from "./pin-collision-layout-solver.ts";
import type { PinCollisionSettings } from "./pin-collision-layout-solver.ts";

/** Test geometry: a pin body of radius 50, a visible circle of 46, the body center 55 px above the anchor. */
const geometry: PinCollisionGeometry = { pinSizePx: 100, bodyRadiusPx: 50, circleBodyRadiusPx: 46, bodyCenterOffsetX: 0, bodyCenterOffsetY: 55 };

function makeConfig(overrides: Partial<PinCollisionSettings> = {}): PinCollisionSettings {
  return { ...defaultPinSettings, collisionPaddingPx: 0, maxOffsetPx: 220, collisionIterations: 10, springK: 0.25, smoothing: 0.35, compressedScale: 0.55, groupingThreshold: 10, ...overrides };
}

const image = PinImageSource.remote("https://example.invalid/pin.png");

interface ProjectedOptions {
  readonly isSelected?: boolean;
  readonly clusterPolicy?: PinClusterPolicy;
  readonly visibilityAlpha?: number;
  readonly world?: readonly [number, number];
}

function point(x: number, y: number, visibilityAlpha = 1): ScreenPointOutput {
  return { positionX: x, positionY: y, depth: 0.5, visible: 1, visibilityAlpha };
}

function makeProjected(id: number, x: number, y: number, options: ProjectedOptions = {}): ProjectedPin {
  const pin = ImmersiveMapPin.make({ id, coordinate: { latitude: 0, longitude: 0 }, image, isSelected: options.isSelected ?? false, clusterPolicy: options.clusterPolicy ?? "none" });
  const projected = projectedPinFromScreen(pin, point(x, y, options.visibilityAlpha ?? 1), id);
  return options.world === undefined ? projected : { ...projected, worldX: options.world[0], worldY: options.world[1] };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const clock = () => ({ time: 0 });

function solveUntilSettled(solver: PinCollisionLayoutSolver, pins: readonly ProjectedPin[], config: PinCollisionSettings, at = clock()): PinCollisionLayout {
  let layout = PinCollisionLayout.empty;
  for (let iteration = 0; iteration < 1200; iteration++) {
    layout = solver.solve(pins, geometry, config, at.time);
    if (!layout.hasActiveAnimations && iteration > 0) return layout;
    at.time += 1 / 60;
  }
  throw new Error("the solver did not settle within the iteration budget");
}

function bodyCenter(item: PinCollisionItem): [number, number] {
  const scale = item.displayScale * item.pin.screenSizeScale;
  return [item.screenPoint.positionX + geometry.bodyCenterOffsetX * scale, item.screenPoint.positionY + geometry.bodyCenterOffsetY * scale];
}

const length = (x: number, y: number) => Math.hypot(x, y);
const offsetLength = (item: PinCollisionItem) => length(item.screenPoint.positionX - item.anchorScreenPoint.positionX, item.screenPoint.positionY - item.anchorScreenPoint.positionY);
const position = (item: PinCollisionItem) => [item.screenPoint.positionX, item.screenPoint.positionY];
const itemOf = (layout: PinCollisionLayout, id: number) => {
  const item = layout.pinItems.find((candidate) => candidate.pin.id === id);
  if (item === undefined) throw new Error(`no item for pin ${id}`);
  return item;
};

/** The actual (compressed) bodies do not overlap beyond the tolerance. */
function expectNoBodyOverlaps(layout: PinCollisionLayout, tolerance = 1): void {
  const radius = (item: PinCollisionItem) => PinCollisionGeometry.bodyRadius(geometry, item.morph) * item.displayScale * item.pin.screenSizeScale;
  const items = layout.pinItems;
  for (let l = 0; l < items.length; l++) {
    for (let r = l + 1; r < items.length; r++) {
      const [lx, ly] = bodyCenter(items[l]!);
      const [rx, ry] = bodyCenter(items[r]!);
      const distance = length(lx - rx, ly - ry);
      if (distance < radius(items[l]!) + radius(items[r]!) - tolerance) {
        throw new Error(`the bodies of pins ${items[l]!.pin.id} and ${items[r]!.pin.id} overlap: ${distance} < ${radius(items[l]!) + radius(items[r]!)}`);
      }
    }
  }
}

describe("PinCollisionLayout.anchored", () => {
  test("pins that do not spread apart stand on their coordinates in draw order", () => {
    const pin = (id: number, drawOrder: number): ProjectedPin => ({ ...makeProjected(id, 50, 100), worldX: 0, worldY: 0, drawOrder });
    // Two pins on the same pixel: with spreading they would be pushed apart.
    const layout = PinCollisionLayout.anchored([pin(2, 1), pin(1, 0)]);
    expect(layout.pinItems.map((item) => item.pin.id)).toEqual([1, 2]);
    expect(layout.hasActiveAnimations).toBe(false);
    for (const item of layout.pinItems) {
      expect(position(item)).toEqual([50, 100]);
      expect(item.anchorScreenPoint).toBe(item.screenPoint);
      expect(item.displayScale).toBe(1);
      expect(item.morph).toBe(0);
    }
  });
});

describe("PinCollisionLayoutSolver: displacement and shape", () => {
  test("a lone pin stays at its anchor as a full-sized pin", () => {
    const layout = new PinCollisionLayoutSolver().solve([makeProjected(1, 400, 300)], geometry, makeConfig(), 0);
    expect(layout.pinItems.length).toBe(1);
    const item = layout.pinItems[0]!;
    expect(position(item)).toEqual([400, 300]);
    expect(item.displayScale).toBe(1);
    expect(item.morph).toBe(0);
    expect(layout.hasActiveAnimations).toBe(false);
  });

  test("displaced pins become smaller circles", () => {
    const config = makeConfig();
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300), makeProjected(2, 415, 300), makeProjected(3, 400, 315)], config);
    // Three or more packed tight: no dominant, all are circles within [compressedScale, displacedCircleScale].
    for (const item of layout.pinItems) {
      expect(item.morph).toBeCloseTo(1, 2);
      expect(item.displayScale).toBeLessThanOrEqual(displacedCircleScale + 0.001);
      expect(item.displayScale).toBeGreaterThanOrEqual(config.compressedScale - 0.001);
    }
    expectNoBodyOverlaps(layout);
  });

  test("a pair keeps the dominant pin and the other yields as a circle", () => {
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300), makeProjected(2, 460, 300)], makeConfig());
    const dominant = itemOf(layout, 1);
    const yielding = itemOf(layout, 2);
    expect(position(dominant)).toEqual([400, 300]);
    expect(dominant.morph).toBe(0);
    expect(dominant.displayScale).toBe(1);
    expect(yielding.morph).toBeCloseTo(1, 2);
    expect(yielding.displayScale).toBeLessThanOrEqual(displacedCircleScale + 0.001);
    expect(offsetLength(yielding)).toBeGreaterThan(10);
    expectNoBodyOverlaps(layout, 2);
  });

  test("the yielding circle touches the dominant without a gap", () => {
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300), makeProjected(2, 440, 300)], makeConfig());
    const dominant = itemOf(layout, 1);
    const yielding = itemOf(layout, 2);
    const [dx, dy] = bodyCenter(dominant);
    const [yx, yy] = bodyCenter(yielding);
    const touching = PinCollisionGeometry.bodyRadius(geometry, dominant.morph) * dominant.displayScale + PinCollisionGeometry.bodyRadius(geometry, yielding.morph) * yielding.displayScale;
    expect(Math.abs(length(dx - yx, dy - yy) - touching)).toBeLessThanOrEqual(1.5);
  });

  test("a pin reacts only to the actual circle body, not to the full-size ghost", () => {
    // A pair {1, 2} (a dominant and a circle sliding down) and pin 3, whose
    // full body touches the displaced full body of 2 but not its actual circle.
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300), makeProjected(2, 400, 380), makeProjected(3, 400, 505)], makeConfig());
    expect(itemOf(layout, 1).morph).toBe(0);
    expect(itemOf(layout, 2).morph).toBeCloseTo(1, 2);
    const bystander = itemOf(layout, 3);
    expect(Math.abs(bystander.morph)).toBeLessThan(0.05);
    expect(Math.abs(bystander.displayScale - 1)).toBeLessThan(0.01);
    expect(position(bystander)).toEqual([400, 505]);
    expectNoBodyOverlaps(layout, 2);
  });

  test("three close pins all become circles", () => {
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), range(1, 3).map((id) => makeProjected(id, 400, 300)), makeConfig());
    expect(layout.pinItems.length).toBe(3);
    for (const item of layout.pinItems) {
      expect(item.morph).toBeCloseTo(1, 2);
      expect(item.displayScale).toBeLessThanOrEqual(displacedCircleScale + 0.001);
      expect(offsetLength(item)).toBeGreaterThan(5);
    }
    expectNoBodyOverlaps(layout, 1.5);
  });

  test("pins do not react before their bodies touch", () => {
    // Bodies of radius 50: an anchor distance of 101 leaves a 1 px gap.
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300), makeProjected(2, 501, 300)], makeConfig());
    for (const item of layout.pinItems) {
      expect(position(item)).toEqual(position({ ...item, screenPoint: item.anchorScreenPoint }));
      expect(item.displayScale).toBe(1);
      expect(item.morph).toBe(0);
    }
  });

  test("a crowd compresses circles down to the limit only", () => {
    const config = makeConfig({ maxOffsetPx: 60 });
    const pins = range(1, 6).map((id) => makeProjected(id, 400, 300));
    pins.push(makeProjected(99, 900, 300));
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, config);
    const lone = itemOf(layout, 99);
    expect(lone.displayScale).toBe(1);
    expect(lone.morph).toBe(0);
    for (const item of layout.pinItems) {
      if (item.pin.id === 99) continue;
      expect(item.displayScale).toBeLessThan(displacedCircleScale + 0.001);
      expect(item.displayScale).toBeGreaterThanOrEqual(config.compressedScale - 0.001);
    }
  });

  test("mixed pin and circle bodies do not overlap", () => {
    const pins = range(1, 6).map((id) => makeProjected(id, 400 + id, 300, { isSelected: id === 1 }));
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig());
    const selected = itemOf(layout, 1);
    expect(selected.displayScale).toBe(1);
    expect(selected.morph).toBe(0);
    for (const item of layout.pinItems) if (item.pin.id !== 1) expect(item.displayScale).toBeLessThanOrEqual(displacedCircleScale + 0.001);
    expectNoBodyOverlaps(layout, 3);
  });

  test("a selected pin is immovable and full sized", () => {
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300, { isSelected: true }), makeProjected(2, 408, 300)], makeConfig());
    const selected = itemOf(layout, 1);
    expect(position(selected)).toEqual([400, 300]);
    expect(selected.displayScale).toBe(1);
    expect(selected.morph).toBe(0);
    expect(offsetLength(itemOf(layout, 2))).toBeGreaterThan(1);
    expectNoBodyOverlaps(layout, 3);
  });

  test("the spring returns a pin to its point when the neighbor disappears", () => {
    const solver = new PinCollisionLayoutSolver();
    const at = clock();
    solveUntilSettled(solver, [makeProjected(1, 400, 300), makeProjected(2, 410, 300)], makeConfig(), at);
    // The dominant disappeared: the yielding circle returns and becomes a full pin again.
    const layout = solveUntilSettled(solver, [makeProjected(2, 410, 300)], makeConfig(), at);
    const item = layout.pinItems[0]!;
    expect(position(item)).toEqual([410, 300]);
    expect(item.displayScale).toBe(1);
    expect(item.morph).toBe(0);
  });

  test("the displacement is clamped by maxOffsetPx", () => {
    const config = makeConfig({ maxOffsetPx: 30 });
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), range(1, 5).map((id) => makeProjected(id, 400, 300)), config);
    // Body centers are compared.
    for (const item of layout.pinItems) {
      const [x, y] = bodyCenter(item);
      const restX = item.anchorScreenPoint.positionX + geometry.bodyCenterOffsetX * item.pin.screenSizeScale;
      const restY = item.anchorScreenPoint.positionY + geometry.bodyCenterOffsetY * item.pin.screenSizeScale;
      expect(length(x - restX, y - restY)).toBeLessThanOrEqual(config.maxOffsetPx + geometry.bodyCenterOffsetY + 1);
    }
  });

  test("coincident pins separate deterministically", () => {
    const run = () => solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300), makeProjected(2, 400, 300)], makeConfig());
    const first = run();
    const second = run();
    expectNoBodyOverlaps(first);
    expect(position(itemOf(first, 1))).toEqual([400, 300]);
    first.pinItems.forEach((item, index) => {
      expect(item.pin.id).toBe(second.pinItems[index]!.pin.id);
      expect(position(item)).toEqual(position(second.pinItems[index]!));
      expect(Number.isNaN(item.screenPoint.positionX) || Number.isNaN(item.screenPoint.positionY)).toBe(false);
    });
  });

  test("the converged layout matches across frame rates", () => {
    const converge = (step: number) => {
      const solver = new PinCollisionLayoutSolver();
      const pins = [makeProjected(1, 400, 300), makeProjected(2, 412, 300)];
      let time = 0;
      for (let i = 0; i < 1200; i++) {
        const layout = solver.solve(pins, geometry, makeConfig(), time);
        if (!layout.hasActiveAnimations) return layout;
        time += step;
      }
      throw new Error("the solver did not settle");
    };
    const at60 = converge(1 / 60);
    const at30 = converge(1 / 30);
    at60.pinItems.forEach((item, index) => {
      const other = at30.pinItems[index]!;
      expect(length(item.screenPoint.positionX - other.screenPoint.positionX, item.screenPoint.positionY - other.screenPoint.positionY)).toBeLessThan(1.5);
      expect(Math.abs(item.displayScale - other.displayScale)).toBeLessThanOrEqual(0.02);
    });
  });

  test("a borderline contact settles without size oscillation", () => {
    // Full-size bodies barely lack room while circles fit: the targets must reach a fixed point.
    const config = makeConfig();
    const solver = new PinCollisionLayoutSolver();
    const pins = [makeProjected(1, 400, 300), makeProjected(2, 505, 300)];
    const at = clock();
    const settled = solveUntilSettled(solver, pins, config, at);
    for (let i = 0; i < 120; i++) {
      at.time += 1 / 60;
      const layout = solver.solve(pins, geometry, config, at.time);
      expect(layout.hasActiveAnimations).toBe(false);
      layout.pinItems.forEach((item, index) => {
        const settledItem = settled.pinItems[index]!;
        expect(Math.abs(item.displayScale - settledItem.displayScale)).toBeLessThanOrEqual(0.001);
        expect(Math.abs(item.morph - settledItem.morph)).toBeLessThanOrEqual(0.001);
        expect(length(item.screenPoint.positionX - settledItem.screenPoint.positionX, item.screenPoint.positionY - settledItem.screenPoint.positionY)).toBeLessThan(0.1);
      });
    }
    expectNoBodyOverlaps(settled, 3);
  });

  test("transient frames never show body overlaps", () => {
    // Anchors teleport next to each other: smoothing lags, the final pass resolves overlaps every frame.
    const config = makeConfig();
    const solver = new PinCollisionLayoutSolver();
    const at = clock();
    solveUntilSettled(solver, [makeProjected(1, 200, 300), makeProjected(2, 700, 300), makeProjected(3, 450, 700)], config, at);
    const piled = [makeProjected(1, 400, 300), makeProjected(2, 408, 300), makeProjected(3, 400, 308)];
    for (let i = 0; i < 240; i++) {
      at.time += 1 / 60;
      expectNoBodyOverlaps(solver.solve(piled, geometry, config, at.time), 1);
    }
  });

  test("an anchor jump carries the offsets without a spike", () => {
    const solver = new PinCollisionLayoutSolver();
    const at = clock();
    const settled = solveUntilSettled(solver, [makeProjected(1, 400, 300), makeProjected(2, 412, 300)], makeConfig(), at);
    const before = new Map(settled.pinItems.map((item) => [item.pin.id, [item.screenPoint.positionX - item.anchorScreenPoint.positionX, item.screenPoint.positionY - item.anchorScreenPoint.positionY] as const]));
    // A teleport like a jump across the world wrap seam: offsets are relative to the anchor.
    at.time += 1 / 60;
    const jumped = solver.solve([makeProjected(1, 5400, 300), makeProjected(2, 5412, 300)], geometry, makeConfig(), at.time);
    for (const item of jumped.pinItems) {
      const [bx, by] = before.get(item.pin.id)!;
      expect(length(item.screenPoint.positionX - item.anchorScreenPoint.positionX - bx, item.screenPoint.positionY - item.anchorScreenPoint.positionY - by)).toBeLessThan(1);
    }
  });

  test("the input order does not change the layout", () => {
    const pins = [makeProjected(3, 400, 308), makeProjected(1, 400, 300), makeProjected(2, 408, 300), makeProjected(9, 900, 300, { isSelected: true })];
    const sorted = [...pins].sort((a, b) => a.pin.id - b.pin.id);
    const shuffled = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig());
    const ordered = solveUntilSettled(new PinCollisionLayoutSolver(), sorted, makeConfig());
    expect(shuffled.pinItems.map((item) => [item.pin.id, ...position(item), item.displayScale, item.morph])).toEqual(ordered.pinItems.map((item) => [item.pin.id, ...position(item), item.displayScale, item.morph]));
  });

  test("an empty frame resets the state and returns the empty layout", () => {
    const solver = new PinCollisionLayoutSolver();
    solver.solve([makeProjected(1, 400, 300), makeProjected(2, 410, 300)], geometry, makeConfig(), 0);
    expect(solver.solve([], geometry, makeConfig(), 1 / 60)).toBe(PinCollisionLayout.empty);
  });

  test("reset forgets the smoothing, so the next frame lands on its targets", () => {
    const solver = new PinCollisionLayoutSolver();
    const pins = [makeProjected(1, 400, 300), makeProjected(2, 410, 300)];
    const settled = solveUntilSettled(solver, pins, makeConfig());
    solver.reset();
    const first = solver.solve(pins, geometry, makeConfig(), 100);
    first.pinItems.forEach((item, index) => expect(position(item)).toEqual(position(settled.pinItems[index]!)));
  });
});

describe("PinCollisionLayoutSolver: flowers", () => {
  test("an event policy pair forms a two-petal flower", () => {
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(1, 400, 300, { clusterPolicy: "event" }), makeProjected(2, 480, 300, { clusterPolicy: "event" })], makeConfig());
    expect(layout.flowerGroups.length).toBe(1);
    expect(layout.flowerGroups[0]!.memberIDs).toEqual([1, 2]);
    expect(layout.flowerGroups[0]!.visibleMemberIDs).toEqual([1, 2]);
    expect(layout.pinItems.length).toBe(2);
    for (const item of layout.pinItems) {
      expect(item.morph).toBeCloseTo(1, 2);
      expect(item.screenPoint.visibilityAlpha).toBeCloseTo(1, 2);
      expect(item.isFlowerPetal).toBe(true);
    }
  });

  test("a flower shows its petals and hides the overflow members", () => {
    const config = makeConfig({ groupingThreshold: 10 });
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), range(1, 12).map((id) => makeProjected(id, 400 + id * 0.5, 300)), config);
    expect(layout.flowerGroups.length).toBe(1);
    const group = layout.flowerGroups[0]!;
    expect(group.memberIDs.length).toBe(12);
    expect(group.visibleMemberIDs.length).toBe(maxFlowerPetals);
    // Members that do not fit are not shown at all.
    expect(layout.pinItems.length).toBe(maxFlowerPetals);
    const ringRadius = flowerRingRadius(geometry.circleBodyRadiusPx * config.compressedScale, maxFlowerPetals);
    for (const item of layout.pinItems) {
      expect(Math.abs(item.displayScale - config.compressedScale)).toBeLessThanOrEqual(0.01);
      expect(item.morph).toBeCloseTo(1, 2);
      const [x, y] = bodyCenter(item);
      expect(Math.abs(length(x - group.centerX, y - group.centerY) - ringRadius)).toBeLessThanOrEqual(2);
    }
  });

  test("petals hold their slots under crowd pressure", () => {
    const config = makeConfig({ groupingThreshold: 2 });
    const pins = range(1, 4).map((id) => makeProjected(id, 400 + id * 0.5, 300));
    [0, 1.57, 3.14, 4.71].forEach((angle, index) => pins.push(makeProjected(50 + index, 400 + Math.cos(angle) * 70, 300 + Math.sin(angle) * 70)));
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, config);
    const group = layout.flowerGroups[0]!;
    const ringRadius = flowerRingRadius(geometry.circleBodyRadiusPx * config.compressedScale, group.visibleMemberIDs.length);
    for (const item of layout.pinItems) {
      if (!item.isFlowerPetal) continue;
      const [x, y] = bodyCenter(item);
      expect(Math.abs(length(x - group.centerX, y - group.centerY) - ringRadius), `petal ${item.pin.id} was knocked out of its slot`).toBeLessThanOrEqual(1);
    }
  });

  test("ten piled pins form a flower with the default settings", () => {
    const config = { ...defaultPinSettings, smoothing: 0.35 };
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), range(1, 10).map((id) => makeProjected(id, 400 + id * 0.5, 300)), config);
    expect(layout.flowerGroups.length).toBe(1);
    expect(layout.flowerGroups[0]!.memberIDs.length).toBe(10);
    expect(layout.flowerGroups[0]!.visibleMemberIDs.length).toBe(maxFlowerPetals);
    expect(layout.pinItems.length).toBe(maxFlowerPetals);
  });

  test("the default grouping boundary is five pins", () => {
    const config = { ...defaultPinSettings, smoothing: 0.35 };
    expect(config.groupingThreshold).toBe(5);
    const pile = (count: number) => solveUntilSettled(new PinCollisionLayoutSolver(), range(1, count).map((id) => makeProjected(id, 400 + id * 0.5, 300)), config);
    const five = pile(5);
    expect(five.flowerGroups.length).toBe(1);
    expect(five.flowerGroups[0]!.memberIDs.length).toBe(5);
    expect(five.flowerGroups[0]!.visibleMemberIDs.length).toBe(5);
    expect(five.pinItems.length).toBe(5);
    const four = pile(4);
    expect(four.flowerGroups.length).toBe(0);
    expect(four.pinItems.length).toBe(4);
    expectNoBodyOverlaps(four, 1.5);
  });

  test("grouping hysteresis keeps a flower between the enter and exit radii", () => {
    const config = makeConfig({ groupingThreshold: 1 });
    const solver = new PinCollisionLayoutSolver();
    let time = 0;
    // The enter radius is 35, the exit radius 45.5 at a pin size of 100.
    const once = (distance: number) => {
      time += 1 / 60;
      return solver.solve([makeProjected(1, 400, 300), makeProjected(2, 400 + distance, 300)], geometry, config, time);
    };
    expect(once(41).flowerGroups.length, "41 px is past the enter radius: no flower").toBe(0);
    expect(once(30).flowerGroups.length, "30 px is within the enter radius: a flower").toBe(1);
    expect(once(41).flowerGroups.length, "41 px is within the exit radius: the flower holds").toBe(1);
    expect(once(60).flowerGroups.length, "60 px is past the exit radius: the flower falls apart").toBe(0);
  });

  test("a selected pin joins a flower as a visible petal", () => {
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), [makeProjected(5, 400, 300, { isSelected: true }), makeProjected(2, 402, 300), makeProjected(3, 404, 300)], makeConfig({ groupingThreshold: 1 }));
    expect(layout.flowerGroups.length).toBe(1);
    expect(layout.flowerGroups[0]!.memberIDs).toEqual([2, 3, 5]);
    // The selected member is guaranteed among the visible petals and comes first.
    expect(layout.flowerGroups[0]!.visibleMemberIDs[0]).toBe(5);
    expect(layout.pinItems.length).toBe(3);
  });

  test("a flower stays put and neighbors react only to a petal touch", () => {
    // The trio's centroid is (400, 300.67). Pin 8 touches the nearest petal,
    // pin 9 only falls inside the ring's invisible circumscribed circle.
    const pins = [makeProjected(1, 398, 300), makeProjected(2, 402, 300), makeProjected(3, 400, 302), makeProjected(8, 440, 300), makeProjected(9, 475, 380)];
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 2 }));
    expect(layout.flowerGroups.length).toBe(1);
    const group = layout.flowerGroups[0]!;
    expect(group.memberIDs).toEqual([1, 2, 3]);
    expect(length(group.centerX - 400, group.centerY - 300.6666)).toBeLessThan(0.01);
    const touching = itemOf(layout, 8);
    expect(offsetLength(touching)).toBeGreaterThan(5);
    expect(touching.morph).toBeGreaterThan(0.5);
    const bystander = itemOf(layout, 9);
    expect(position(bystander)).toEqual([475, 380]);
    expect(Math.abs(bystander.morph)).toBeLessThan(0.05);
    expect(Math.abs(bystander.displayScale - 1)).toBeLessThan(0.01);
  });

  test("overlapping flowers merge into one", () => {
    const pins = [...range(1, 3).map((id) => makeProjected(id, 400 + id, 300)), ...range(11, 13).map((id) => makeProjected(id, 460 + id, 300))];
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 2 }));
    expect(layout.flowerGroups.length).toBe(1);
    expect(layout.flowerGroups[0]!.memberIDs.length).toBe(6);
    expectNoBodyOverlaps(layout, 1.5);
  });

  test("a selected pin touching a flower joins it as a petal", () => {
    const pins = [makeProjected(1, 398, 300), makeProjected(2, 402, 300), makeProjected(3, 400, 302), makeProjected(9, 470, 300, { isSelected: true })];
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 2 }));
    expect(layout.flowerGroups.length).toBe(1);
    expect(layout.flowerGroups[0]!.memberIDs).toEqual([1, 2, 3, 9]);
    expect(layout.flowerGroups[0]!.visibleMemberIDs[0]).toBe(9);
    expectNoBodyOverlaps(layout, 1.5);
  });

  test("a pin anchored inside the ring is absorbed", () => {
    const pins = [makeProjected(1, 398, 300), makeProjected(2, 402, 300), makeProjected(3, 400, 302), makeProjected(9, 400, 320)];
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 2 }));
    expect(layout.flowerGroups.length).toBe(1);
    expect(layout.flowerGroups[0]!.memberIDs).toEqual([1, 2, 3, 9]);
  });

  test("hidden flower members reappear after a breakup", () => {
    const config = makeConfig({ groupingThreshold: 3 });
    const solver = new PinCollisionLayoutSolver();
    const at = clock();
    const piled = solveUntilSettled(solver, range(1, 9).map((id) => makeProjected(id, 400 + id * 0.5, 300)), config, at);
    expect(piled.pinItems.length).toBe(maxFlowerPetals);
    // The anchors fly apart: the flower disbands and the hidden members return.
    const spread = solveUntilSettled(solver, range(1, 9).map((id) => makeProjected(id, id * 400, 300)), config, at);
    expect(spread.flowerGroups.length).toBe(0);
    expect(spread.pinItems.length).toBe(9);
  });

  test("a breakup flies the members out of the fading flower center", () => {
    const config = makeConfig({ groupingThreshold: 3 });
    const solver = new PinCollisionLayoutSolver();
    const at = clock();
    solveUntilSettled(solver, range(1, 9).map((id) => makeProjected(id, 400 + id * 0.5, 300)), config, at);
    at.time += 1 / 60;
    const first = solver.solve(range(1, 9).map((id) => makeProjected(id, id * 400, 300)), geometry, config, at.time);
    expect(first.hasActiveAnimations).toBe(true);
    // The members hidden in the flower start faded at its center.
    const hidden = first.pinItems.filter((item) => item.screenPoint.visibilityAlpha < 0.99);
    expect(hidden.length).toBeGreaterThan(0);
  });
});

describe("PinCollisionLayoutSolver: cluster locality", () => {
  test("a sprawling chain splits into local flowers", () => {
    const pins = range(0, 16).map((step) => makeProjected(step + 1, 400 + step * 30, 300));
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 3 }));
    const compactnessLimit = geometry.pinSizePx * flowerCompactnessLimitScale;
    expect(layout.flowerGroups.length, "the oversized group was not split").toBeGreaterThan(1);
    let covered = 0;
    for (const group of layout.flowerGroups) {
      covered += group.memberIDs.length;
      for (const id of group.memberIDs) {
        expect(length(400 + (id - 1) * 30 - group.centerX, 300 - group.centerY), `the anchor of member ${id} is far from its ring`).toBeLessThan(compactnessLimit);
      }
    }
    expect(covered).toBe(17);
    expectNoBodyOverlaps(layout, 1.5);
  });

  test("the world grid split is stable under a pan", () => {
    const compositions = (panX: number, panY: number) => {
      const pins = range(0, 16).map((step) => {
        const x = 400 + step * 30;
        return makeProjected(step + 1, x + panX, 300 + panY, { world: [x * 0.001, 300 * 0.001] });
      });
      return solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 3 })).flowerGroups.map((group) => group.memberIDs);
    };
    expect(compositions(37, 53), "panning rebuilt the cluster memberships").toEqual(compositions(0, 0));
  });

  test("unmergeable intersecting rings separate without overlap", () => {
    // A dense five and a long chain nearby: their rings intersect, but the
    // compactness limit forbids merging, so the smaller group yields.
    const pins = [...range(1, 5).map((id) => makeProjected(id, 400 + id * 0.5, 300)), ...range(0, 8).map((step) => makeProjected(20 + step, 450, 315 + step * 30))];
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 2 }));
    expect(layout.flowerGroups.length, "the clusters merged although the compactness limit forbids it").toBe(2);
    const small = layout.flowerGroups.find((group) => group.memberIDs.length === 5)!;
    const large = layout.flowerGroups.find((group) => group.memberIDs.length === 9)!;
    expect(length(large.centerX - 450, large.centerY - 435)).toBeLessThan(1);
    expect(length(small.centerX - 401.5, small.centerY - 300)).toBeGreaterThan(1);
    expectNoBodyOverlaps(layout, 1.5);
  });

  test("a dense mosaic of flowers has no petal overlaps", () => {
    // A 64 bit LCG as in Swift, its top 24 bits as the fraction.
    let state = 7n;
    const random = () => {
      state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(state >> 40n) / Number(0xffffffffffffffffn >> 40n);
    };
    const pins = range(1, 800).map((id) => {
      const angle = random() * 2 * Math.PI;
      const radius = 600 * Math.sqrt(random());
      return makeProjected(id, 900 + Math.cos(angle) * radius, 450 + Math.sin(angle) * radius * 0.5);
    });
    const layout = solveUntilSettled(new PinCollisionLayoutSolver(), pins, makeConfig({ groupingThreshold: 5 }));
    expect(layout.flowerGroups.length, "a dense field must produce a mosaic of clusters").toBeGreaterThan(3);
    expectNoBodyOverlaps(layout, 1.5);
  });
});

describe("PinCollisionLayoutSolver: large scenes do bounded work", () => {
  // The Swift `PinPerformanceTests` scenes: their timings are a benchmark
  // (bench-pins), here only the structure of the result is checked.
  test("a 30 000 pin pile collapses into one flower", () => {
    const next = mulberry(42);
    const pins = range(1, 30_000).map((id) => {
      const angle = next() * 2 * Math.PI;
      const distance = 150 * Math.sqrt(next());
      return makeProjected(id, 800 + Math.cos(angle) * distance, 500 + Math.sin(angle) * distance);
    });
    const bigGeometry: PinCollisionGeometry = { pinSizePx: 128, bodyRadiusPx: 64, circleBodyRadiusPx: 59, bodyCenterOffsetX: 0, bodyCenterOffsetY: 70 };
    const solver = new PinCollisionLayoutSolver();
    let layout = PinCollisionLayout.empty;
    for (let frame = 0; frame < 3; frame++) layout = solver.solve(pins, bigGeometry, { ...defaultPinSettings, smoothing: 0.35 }, frame / 60);
    expect(layout.pinItems.length).toBeLessThanOrEqual(30_000);
    expect(layout.flowerGroups.length).toBeGreaterThan(0);
    expect(layout.flowerGroups.reduce((sum, group) => sum + group.memberIDs.length, 0)).toBeGreaterThan(29_000);
  });
});

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
