// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelVisibilityResolverTests`: the per-label
// rules of the frame path, which labels reserve collision space and which
// want to be shown, written in place over the set's columns.

import { describe, expect, test } from "vitest";
import { BaseLabelVisibilityResolver as Resolver, showsAtZoom, type BaseLabelPresentation } from "./base-label-visibility-resolver.ts";

interface Input {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly isLocal?: boolean;
  readonly isCopy?: boolean;
}

function presentation(inputs: readonly Input[]): BaseLabelPresentation {
  return {
    minCameraZoom: Float32Array.from(inputs.map((input) => input.minZoom ?? 0)),
    maxCameraZoom: Float32Array.from(inputs.map((input) => input.maxZoom ?? Infinity)),
    isLocal: Uint8Array.from(inputs.map((input) => Number(input.isLocal ?? false))),
    isCopy: Uint8Array.from(inputs.map((input) => Number(input.isCopy ?? false))),
  };
}

function flags(...values: boolean[]): Uint8Array {
  return Uint8Array.from(values.map(Number));
}

/** The whole set as one span. */
function all(count: number): number[] {
  return [0, count];
}

function target(inputs: readonly Input[], collision: Uint8Array, horizon: Uint8Array, cameraZoom: number, local = new Uint8Array(0)): boolean[] {
  const out = new Uint8Array(inputs.length);
  Resolver.targetVisibility(presentation(inputs), collision, horizon, local, cameraZoom, all(inputs.length), out);
  return Array.from(out, Boolean);
}

function reserves(screenVisible: boolean, horizonVisible: boolean, currentAlpha: number, minCameraZoom: number, cameraZoom: number, maxCameraZoom = Infinity, localSuppressed = false): boolean {
  return Resolver.reservesSpaceOne(screenVisible, horizonVisible, localSuppressed, currentAlpha, minCameraZoom, maxCameraZoom, cameraZoom);
}

/** The look-at point is in z15 tile (10, 20), inside z14 tile (5, 10). */
const mercator: [number, number] = [10.5 / 32768, 20.5 / 32768];

describe("BaseLabelVisibilityResolver", () => {
  // A label past its maximum camera zoom (a country's name among the
  // streets) hides as one below its minimum does: it wants to be hidden and,
  // once faded, reserves nothing.
  test("a label past its maximum zoom hides", () => {
    const inputs: Input[] = [{ maxZoom: 8 }, { minZoom: 3, maxZoom: 8 }, {}];
    const yes = flags(true, true, true);
    expect(target(inputs, yes, yes, 7.9), "below the maximum every label shows").toEqual([true, true, true]);
    expect(target(inputs, yes, yes, 8), "at the maximum the land's names go, the city's stays").toEqual([false, false, true]);

    expect(reserves(true, true, 0, 0, 9, 8), "past its zooms and faded: reserves nothing").toBe(false);
    expect(reserves(true, true, 0.5, 0, 9, 8), "but keeps its spot while it fades out").toBe(true);
    const single = presentation([{ maxZoom: 8 }]);
    expect(showsAtZoom(single, 0, 7.99)).toBe(true);
    expect(showsAtZoom(single, 0, 8)).toBe(false);
  });

  test("the target visibility requires the horizon, the collision and the zoom", () => {
    const result = target([{}, {}, {}, { minZoom: 15 }], flags(true, true, false, true), flags(true, false, true, true), 14);
    expect(result, "behind the horizon, lost the collision, below its zoom: each hides").toEqual([true, false, false, false]);
  });

  test("a missing collision entry counts as hidden", () => {
    expect(target([{}, {}], flags(true), flags(true, true), 14)).toEqual([true, false]);
  });

  test("only the labels of the spans are decided, the rest are cleared", () => {
    const inputs: Input[] = [{}, {}, {}];
    const out = flags(true, true, true);
    Resolver.targetVisibility(presentation(inputs), flags(true, true, true), flags(true, true, true), new Uint8Array(0), 14, [1, 2], out);
    expect(Array.from(out, Boolean)).toEqual([false, true, false]);
  });

  // Local detail (house numbers, plaques) keeps to the three by three tiles
  // around the look-at tile, counted in its own tile's grid, and a coarser
  // stand-in holding the look-at point counts as inside.
  test("local detail keeps to the block around the look-at tile", () => {
    const local: Input = { isLocal: true };
    const inputs: Input[] = [local, local, local, {}, local];
    // z, x, y per label.
    const tiles = Int32Array.from([15, 10, 20, 15, 11, 21, 15, 12, 20, 15, 12, 20, 14, 5, 10]);
    const anchors = new Float32Array(inputs.length * 3);
    const suppressed = new Uint8Array(inputs.length);
    const changed = Resolver.localSuppression(presentation(inputs), tiles, anchors, mercator, { eye: [0, 0, 0], unitsPerMeter: undefined, maximumDistanceMeters: 0 }, all(inputs.length), suppressed);
    expect(changed).toBe(true);
    expect(Array.from(suppressed, Boolean), "the look-at tile, the diagonal beside it, two tiles away, not local, the coarser stand-in").toEqual([false, false, true, false, false]);

    const yes = flags(true, true, true, true, true);
    expect(target(inputs, yes, yes, 17, suppressed)).toEqual([true, true, false, true, true]);
  });

  test("the look-at block wraps across the antimeridian", () => {
    expect(Resolver.isWithinLookAtBlock(2, 3, 1, [0.01, 0.3])).toBe(true);
    expect(Resolver.isWithinLookAtBlock(2, 2, 1, [0.01, 0.3])).toBe(false);
  });

  // Inside the block, the distance from the camera decides, measured in
  // metres through the look-at point's scale.
  test("local detail keeps to the distance from the camera", () => {
    const inputs: Input[] = [{ isLocal: true }, { isLocal: true }];
    const tiles = Int32Array.from([15, 10, 20, 15, 10, 20]);
    // Two units per metre: 300 m is 600 units.
    const reach = { eye: [0, 0, 100] as [number, number, number], unitsPerMeter: 2, maximumDistanceMeters: 300 };
    const anchors = Float32Array.from([0, 500, 0, 0, 700, 0]);
    const suppressed = new Uint8Array(2);
    Resolver.localSuppression(presentation(inputs), tiles, anchors, mercator, reach, all(2), suppressed);
    expect(Array.from(suppressed, Boolean)).toEqual([false, true]);

    const unchanged = Resolver.localSuppression(presentation(inputs), tiles, anchors, mercator, reach, all(2), suppressed);
    expect(unchanged, "the same pose answers the same, and asks for no new solve").toBe(false);
  });

  // Outside the look-at tile a local label keeps its space only while it
  // fades out, like one below its zoom.
  test("local detail outside the look-at tile reserves nothing once invisible", () => {
    expect(reserves(true, true, 0.4, 0, 17, Infinity, true)).toBe(true);
    expect(reserves(true, true, 0, 0, 17, Infinity, true)).toBe(false);
  });

  test("the reservation remains during a fade out behind the horizon", () => {
    expect(reserves(true, false, 0.4, 0, 14), "still fading out behind the horizon: keeps its space so neighbours do not jump").toBe(true);
    expect(reserves(true, false, 0, 0, 14), "fully transparent behind the horizon: reserves nothing").toBe(false);
  });

  test("the reservation needs a drawable point", () => {
    expect(reserves(false, true, 1, 0, 14)).toBe(false);
  });

  // The whole-set pass answers what the single rule answers, label by
  // label, and a copy of another tile's feature reserves nothing.
  test("the reservation pass matches the rule", () => {
    const inputs: Input[] = [{}, { minZoom: 15 }, {}, { isCopy: true }];
    const out = new Uint8Array(inputs.length);
    Resolver.reservesSpace(presentation(inputs), flags(true, true, false, true), flags(true, true, true, true), new Uint8Array(0), Float32Array.from([0, 0, 1, 1]), 14, all(inputs.length), out);
    expect(Array.from(out, Boolean), "in view, below its zoom and invisible, no drawable point, a copy").toEqual([true, false, false, false]);
  });

  test("the reservation is suppressed below the minimum camera zoom while invisible", () => {
    expect(reserves(true, true, 0, 15, 14), "a zoom-hidden POI must not displace visible labels").toBe(false);
    expect(reserves(true, true, 0.5, 15, 14), "but one still fading out after crossing the zoom keeps its spot").toBe(true);
    expect(reserves(true, true, 0, 15, 16)).toBe(true);
  });
});
