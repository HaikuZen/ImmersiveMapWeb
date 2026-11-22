// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeTileCoverageTests`: the ring rules read off the
// globe's grid from the look-at tile, with the pinned world cover as the
// floor and as the ground past the last rule, and the frustum and horizon
// rejects of the tree walk.

import { describe, expect, test } from "vitest";
import { Frustum } from "../../camera/frustum.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import { Matrix, mat4Identity, mat4Multiply } from "../../math/matrix.ts";
import { type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import { type Tile, tileCovers } from "../tile.ts";
import { flatRingRule, FlatRingRules } from "./flat-ring-rules.ts";
import { GlobeRingMath, type GridCell } from "./globe-ring-math.ts";
import { type GlobeCoverageInputs, GlobeTileCoverage } from "./globe-tile-coverage.ts";

const globe: GlobeUniform = { panX: 0, panY: 0, radius: 1, transition: 0 };

/** The globe at pan zero looks at longitude and latitude zero, the corner four tiles share: the look-at tile is the south-east one. */
function inputs(eyeDistance: number, rules: FlatRingRules = FlatRingRules.default, targetZoom = 6, uniform: GlobeUniform = globe, lookAtTile?: GridCell): GlobeCoverageInputs {
  const half = 2 ** targetZoom / 2;
  return { eye: [0, 0, eyeDistance], globe: uniform, rules, lookAtTile: lookAtTile ?? { x: half, y: half } };
}

/** A wide frustum looking at the sphere's front point from the eye. */
function frustum(eyeDistance: number, fovRadians = Math.PI * 0.6): Frustum {
  const view = Matrix.lookAt(mat4Identity(), [0, 0, eyeDistance], [0, 0, -1], [0, 1, 0]);
  const projection = Matrix.perspectiveMatrix(mat4Identity(), fovRadians, 1, 0.001, 100);
  return new Frustum(mat4Multiply(mat4Identity(), projection, view));
}

const v = (x: number, y: number, z: number): VisibleTile => ({ tile: { x, y, z }, worldWrap: 0 });
const same = (a: Tile, b: Tile) => a.x === b.x && a.y === b.y && a.z === b.z;
const contains = (output: readonly VisibleTile[], tile: VisibleTile) => output.some((t) => visibleTileKey(t) === visibleTileKey(tile));
const cover = (tile: Tile, output: readonly VisibleTile[]) => output.find((t) => same(t.tile, tile) || tileCovers(t.tile, tile));
const keyedZoom = (key: string) => Number(key.split("/")[0]);
const floor = GlobeTileCoverage.floorZoom;

/** The eye is high enough for the frustum to hold the first three rings whole. */
function resolve(eyeDistance = 0.3, rules: FlatRingRules = FlatRingRules.default, targetZoom = 6) {
  return GlobeTileCoverage.targets(targetZoom, inputs(eyeDistance, rules, targetZoom), frustum(eyeDistance));
}

describe("GlobeTileCoverage", () => {
  test("the rings around the look-at tile follow the rules", () => {
    const resolution = resolve();
    const output = resolution.targets;
    for (let x = 31; x <= 33; x++) {
      for (let y = 31; y <= 33; y++) expect(contains(output, v(x, y, 6)), `ring 1 is exact: z6/${x}/${y}`).toBe(true);
    }
    expect(contains(output, v(34, 32, 6)), "ring 2 is not drawn at the target zoom").toBe(false);
    expect(output.find((t) => t.tile.z === 5 && tileCovers(t.tile, { x: 34, y: 32, z: 6 })), "ring 2 is one level coarser").toBeDefined();
    expect(output.find((t) => t.tile.z === 4 && tileCovers(t.tile, { x: 35, y: 32, z: 6 })), "ring 3 is two levels coarser").toBeDefined();
    expect(output.every((t) => t.tile.z >= floor)).toBe(true);
    expect(resolution.metrics.visitedNodeCount, "the walk stays small").toBeLessThan(600);
    for (let x = 28; x <= 36; x++) {
      for (let y = 28; y <= 36; y++) expect(cover({ x, y, z: 6 }, output), `z6/${x}/${y} in front of the eye is covered`).toBeDefined();
    }
  });

  test("every target sits in a band of its zoom", () => {
    const rules = FlatRingRules.normalized(FlatRingRules.default).rules;
    const output = resolve().targets;
    expect(output.length).toBeGreaterThan(0);
    for (const target of output) {
      const rings = GlobeRingMath.ringRange(target.tile, 6, { x: 32, y: 32 });
      let firstRing = 0;
      let answers = target.tile.z === floor && rings.upperBound > (rules.at(-1)?.distance ?? 0);
      for (const rule of rules) {
        const zoom = Math.max(floor, 6 - rule.zoomDrop);
        if (zoom === target.tile.z && firstRing <= rings.upperBound && rule.distance >= rings.lowerBound) answers = true;
        firstRing = rule.distance + 1;
      }
      expect(answers, `${visibleTileKey(target)} at rings ${rings.lowerBound}...${rings.upperBound} answers to no rule`).toBe(true);
    }
  });

  test("the bands report their zooms and counts", () => {
    const resolution = resolve();
    expect(resolution.bands.map((band) => band.zoom)).toEqual([6, 5, 4, 2]);
    expect(resolution.bands.map((band) => band.distance)).toEqual([1, 2, 3, 9]);
    expect(resolution.bands[0]?.tileCount, "the look-at tile and ring 1, all in view").toBe(9);
    const banded = resolution.bands.reduce((sum, band) => sum + band.tileCount, 0);
    expect(banded).toBeLessThanOrEqual(resolution.targets.length);
  });

  test("parents overlap the exact tiles", () => {
    const output = resolve().targets;
    const exact = output.filter((t) => t.tile.z === 6);
    const parents = output.filter((t) => t.tile.z < 6);
    expect(parents.some((parent) => exact.some((e) => tileCovers(parent.tile, e.tile))), "some parent contains an exact tile").toBe(true);
  });

  test("past the last rule the ground is the cover", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1)] };
    const output = resolve(0.3, rules).targets;
    expect(contains(output, v(32, 32, 6))).toBe(true);
    expect(contains(output, v(0, 0, floor))).toBe(true);
    expect(output.every((t) => t.tile.z === 6 || t.tile.z === floor)).toBe(true);
    expect(output.filter((t) => t.tile.z === 6).length).toBe(9);
  });

  test("the rings cross the antimeridian", () => {
    const seamGlobe: GlobeUniform = { panX: 1, panY: 0, radius: 1, transition: 0 };
    const output = GlobeTileCoverage.targets(6, inputs(0.3, FlatRingRules.default, 6, seamGlobe, { x: 0, y: 32 }), frustum(0.3)).targets;
    expect(contains(output, v(0, 32, 6))).toBe(true);
    expect(contains(output, v(63, 32, 6)), "the ring's column across the seam is exact").toBe(true);
    expect(contains(output, v(62, 32, 6)), "ring 2 across the seam is coarser").toBe(false);
  });

  test("shallow targets stay sane", () => {
    for (let zoom = 0; zoom <= 2; zoom++) {
      const output = resolve(4, FlatRingRules.default, zoom).targets;
      expect(output.length, `z${zoom}`).toBeGreaterThan(0);
      expect(output.every((t) => t.tile.z >= floor && t.tile.z <= zoom), `z${zoom}`).toBe(true);
      expect(output.some((t) => t.tile.z === zoom), `the look-at tile is exact at z${zoom}`).toBe(true);
    }
    expect(GlobeTileCoverage.targets(6, inputs(4), null).targets).toEqual([]);
  });

  test("any rule list covers the view", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(2, 1), flatRingRule(0, 3), flatRingRule(3, 30)] };
    const output = resolve(0.3, rules).targets;
    expect(contains(output, v(35, 32, 6)), "ring 3 is exact under the second rule").toBe(true);
    for (let x = 28; x <= 36; x++) {
      for (let y = 28; y <= 36; y++) expect(cover({ x, y, z: 6 }, output), `z6/${x}/${y} is covered`).toBeDefined();
    }
  });

  test("a lineless rule names its tiles", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 6, { drawsLines: false })] };
    const resolution = resolve(0.3, rules);
    expect(resolution.linelessTargets.size).toBeGreaterThan(0);
    for (const key of resolution.linelessTargets) expect([4, floor]).toContain(keyedZoom(key));
    expect(resolution.linelessTargets.has(visibleTileKey(v(0, 0, floor)))).toBe(true);
    expect(resolution.linelessTargets.has(visibleTileKey(v(32, 32, 6)))).toBe(false);
    expect([...resolve().linelessTargets].every((key) => keyedZoom(key) < 6), "the default's exact tiles stay lined").toBe(true);
  });

  test("an unlabelled rule names its tiles", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 6, { drawsLabels: false })] };
    const resolution = resolve(0.3, rules);
    expect(resolution.unlabelledTargets.size).toBeGreaterThan(0);
    for (const key of resolution.unlabelledTargets) expect([4, floor]).toContain(keyedZoom(key));
    expect(resolution.unlabelledTargets.has(visibleTileKey(v(32, 32, 6)))).toBe(false);
    expect(resolution.linelessTargets.size, "the two switches are independent").toBe(0);
    expect([...resolve().unlabelledTargets].every((key) => keyedZoom(key) < 6), "the default labels the exact tiles and nothing past them").toBe(true);
  });

  test("a raster rule names its tiles", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 6, { rasterSize: 128 })] };
    const resolution = resolve(0.3, rules);
    expect(resolution.rasterTargets.size).toBeGreaterThan(0);
    for (const [key, spec] of resolution.rasterTargets) {
      expect([4, floor]).toContain(keyedZoom(key));
      expect(spec).toEqual({ size: 128 });
    }
    expect(resolution.rasterTargets.get(visibleTileKey(v(0, 0, floor)))).toEqual({ size: 128 });
    expect(resolution.rasterTargets.get(visibleTileKey(v(32, 32, 6)))).toBeUndefined();
    expect([...resolve().rasterTargets.keys()].every((key) => keyedZoom(key) < 6), "the default's exact tiles are geometry").toBe(true);
    expect(resolve(0.3, FlatRingRules.globeDefault).rasterTargets.size, "the globe's default draws every ring as geometry").toBe(0);
  });

  test("the walk carries nothing over", () => {
    expect(resolve().targets).toEqual(resolve().targets);
  });
});
