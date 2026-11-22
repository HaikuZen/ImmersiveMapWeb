// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `FlatRingRuleCoverageTests`: the ground in view cut
// into bands by the distance in tiles from the look-at tile, one band per
// rule, each drawn at the rule's zoom, nothing beyond the last rule and
// nothing outside the footprint. The debug panel's tests (the readout line,
// the control state, the sliders and the raster picker) belong to the debug
// overlay, which is not ported here.

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { RenderCamera } from "../../camera/render-camera.ts";
import { RenderCameraPoseResolver } from "../../camera/render-camera-pose-resolver.ts";
import { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2 } from "../../math/vec.ts";
import { PresentationStateResolver } from "../../presentation/presentation-state-resolver.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import { type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import { type CoveragePolygon, CoveragePolygonBuilder } from "./coverage-polygon.ts";
import { FlatRingRuleCoverage, type FlatRingRuleCoverageResolution, type FlatRingSquare } from "./flat-ring-rule-coverage.ts";
import { flatRingRule, FlatRingRules } from "./flat-ring-rules.ts";
import { FlatTileCoverage } from "./flat-tile-coverage.ts";
import { TileCulling } from "./tile-culling.ts";

interface Fixture {
  readonly flatRenderState: FlatRenderState;
  readonly polygon: CoveragePolygon;
}

const degrees = Math.PI / 180;

/** The render camera's matrix as the engine poses it for the camera state, over the flat world. */
function cameraMatrixOf(cameraState: ImmersiveMapCameraState, aspect: number) {
  const presentation = PresentationStateResolver.resolve(cameraState, ImmersiveMapSettings.default.presentation, "flat");
  const camera = new RenderCamera();
  camera.recalculateProjection(aspect);
  new RenderCameraPoseResolver().updateIfNeeded(camera, cameraState, presentation.presentationState.transition);
  const cameraMatrix = camera.cameraMatrix;
  if (cameraMatrix === null) throw new Error("the camera has a matrix");
  return { presentation, cameraMatrix };
}

/**
 * The render camera as the engine poses it (`RenderCameraPoseResolver`,
 * `RenderCamera`): the look-at at the world origin, the eye at the camera
 * distance, pitched and turned, over the flat world of
 * `PresentationStateResolver`.
 */
function makeFixture(zoom: number, pitchDegrees: number, bearingDegrees = 0, aspect = 4 / 3): Fixture {
  const center = ImmersiveMapProjection.worldMercator(40.7 * degrees, -74 * degrees);
  const cameraState = ImmersiveMapCameraState.make(center, zoom, bearingDegrees * degrees, pitchDegrees * degrees);
  const { presentation, cameraMatrix } = cameraMatrixOf(cameraState, aspect);
  const polygon = CoveragePolygonBuilder.make(cameraMatrix);
  if (polygon === undefined) throw new Error("the footprint exists");
  return { flatRenderState: presentation.flatRenderState, polygon };
}

/** `backdropZoom` null resolves without a backdrop. */
function resolve(fixture: Fixture, targetZoom: number, rules: FlatRingRules = FlatRingRules.default, backdropZoom: number | null = TileCulling.flatBackdropZoomLevel) {
  return FlatRingRuleCoverage.resolve(fixture.flatRenderState, targetZoom, backdropZoom ?? undefined, rules, fixture.polygon);
}

function rect(tile: VisibleTile, fixture: Fixture): FlatRingSquare {
  const origin = ImmersiveMapProjection.flatTileOriginAndSize(tile.tile.x, tile.tile.y, tile.tile.z, tile.worldWrap, fixture.flatRenderState.pan, fixture.flatRenderState.renderMapSize);
  return { minX: origin[0], minY: origin[1], maxX: origin[0] + origin[2], maxY: origin[1] + origin[2] };
}

/** Whether the two rectangles share ground, more than an edge. */
function overlap(a: FlatRingSquare, b: FlatRingSquare): boolean {
  const slack = 1e-4;
  return a.minX < b.maxX - slack && a.maxX > b.minX + slack && a.minY < b.maxY - slack && a.maxY > b.minY + slack;
}

function lies(a: FlatRingSquare, b: FlatRingSquare): boolean {
  const slack = 1e-4;
  return a.minX >= b.minX - slack && a.maxX <= b.maxX + slack && a.minY >= b.minY - slack && a.maxY <= b.maxY + slack;
}

function meetsFootprint(tile: VisibleTile, fixture: Fixture): boolean {
  const r = rect(tile, fixture);
  return fixture.polygon.intersects(r.minX, r.minY, r.maxX, r.maxY);
}

const keySet = (tiles: Iterable<VisibleTile>) => new Set([...tiles].map(visibleTileKey));
const tileOfKey = (resolution: FlatRingRuleCoverageResolution, key: string) => resolution.targets.find((target) => visibleTileKey(target) === key);

describe("CoveragePolygonBuilder", () => {
  test("the footprint over the relief holds the plane's and reaches past it", () => {
    const center = ImmersiveMapProjection.worldMercator(46 * degrees, 7.7 * degrees);
    const cameraState = ImmersiveMapCameraState.make(center, 12.5, 0, 1.1);
    const { cameraMatrix } = cameraMatrixOf(cameraState, 4 / 3);
    const plane = CoveragePolygonBuilder.make(cameraMatrix)!;
    const slab = CoveragePolygonBuilder.make(cameraMatrix, { lowerBound: -0.05, upperBound: 0.2 })!;
    expect(plane).toBeDefined();
    expect(slab).toBeDefined();
    for (const vertex of plane.vertices) {
      expect(slab.intersects(vertex[0] - 1e-4, vertex[1] - 1e-4, vertex[0] + 1e-4, vertex[1] + 1e-4), "the plane's footprint lies within the slab's").toBe(true);
    }
    expect(slab.bounds.minX, "wider at the sides").toBeLessThan(plane.bounds.minX);
    expect(slab.bounds.maxX).toBeGreaterThan(plane.bounds.maxX);
    expect(Math.abs(slab.signedArea)).toBeGreaterThan(Math.abs(plane.signedArea));
    expect(slab.vertices.length).toBeGreaterThan(2);
    const same = CoveragePolygonBuilder.make(cameraMatrix, { lowerBound: 0, upperBound: 0 })!;
    expect(same.vertices.length, "a slab of no height is the plane").toBe(plane.vertices.length);
  });
});

describe("FlatRingRuleCoverage", () => {
  test("each band carries its rule's terrain zoom", () => {
    const fixture = makeFixture(13.4, 60);
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 3, { terrainZoomDrop: 5 })] };
    const resolved = resolve(fixture, 13, rules);
    expect(resolved.bands.map((band) => band.zoom)).toEqual([13, 11]);
    expect(resolved.bands.map((band) => band.terrainZoom)).toEqual([13, 6]);
    expect(
      resolve(fixture, 13).bands.map((band) => band.terrainZoom),
      "the defaults: the near ring's own, three under it past the near ring, seven for the far band",
    ).toEqual([13, 10, 10, 6]);
  });

  // The rules

  test("the rules are normalized", () => {
    const messy: FlatRingRules = { rules: [flatRingRule(3, 4), flatRingRule(-1, 1), flatRingRule(99, -5), flatRingRule(1, 4), flatRingRule(2, 100_000)] };
    const normalized = FlatRingRules.normalized(messy);
    expect(normalized.rules.map((rule) => rule.distance)).toEqual([0, 1, 4, FlatRingRules.distanceRange.upperBound]);
    expect(normalized.rules.map((rule) => rule.zoomDrop), "drops clamped, the first of two rules at one distance kept").toEqual([FlatRingRules.zoomDropRange.upperBound, 0, 3, 2]);
    expect(FlatRingRules.normalized({ rules: [] }), "at least one rule").toEqual(FlatRingRules.default);
    expect(FlatRingRules.normalized(FlatRingRules.default), "the default is already normal").toEqual(FlatRingRules.default);
    expect(FlatRingRules.default.rules.map((rule) => rule.zoomDrop)).toEqual([0, 1, 2, 4]);
    expect(FlatRingRules.default.rules.map((rule) => rule.distance)).toEqual([1, 2, 3, 9]);
    expect(FlatRingRules.default.rules.map((rule) => rule.drawsLines)).toEqual([true, false, false, false]);
    expect(FlatRingRules.default.rules.map((rule) => rule.drawsLabels), "only the exact tiles are labelled").toEqual([true, false, false, false]);
    expect(FlatRingRules.default.rules.map((rule) => rule.rasterSize), "past the exact tiles the ground is textures").toEqual([undefined, 128, 128, 64]);
    expect(
      FlatRingRules.normalized({ rules: [flatRingRule(0, 1, { drawsLabels: false })] }).rules.map((rule) => rule.drawsLabels),
      "the label switch survives normalizing",
    ).toEqual([false]);
  });

  test("an unlabelled rule names its tiles", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 20, { drawsLabels: false })] };
    const fixture = makeFixture(16, 75, 47);
    const resolution = resolve(fixture, 16, rules);
    expect(resolution.unlabelledTargets.size).toBeGreaterThan(0);
    for (const key of resolution.unlabelledTargets) expect(tileOfKey(resolution, key)?.tile.z, key).toBe(14);
    expect(resolution.targets.filter((t) => t.tile.z === 16).every((t) => !resolution.unlabelledTargets.has(visibleTileKey(t)))).toBe(true);
    expect(resolution.linelessTargets.size, "the two switches are independent").toBe(0);
    const defaultResolution = resolve(fixture, 16);
    expect(defaultResolution.unlabelledTargets.size, "the default leaves the far rings unlabelled").toBeGreaterThan(0);
    expect(
      defaultResolution.targets.filter((t) => t.tile.z === 16).every((t) => !defaultResolution.unlabelledTargets.has(visibleTileKey(t))),
      "the default labels the exact tiles",
    ).toBe(true);
  });

  test("a raster rule names its tiles with their size", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 20, { rasterSize: 256 })] };
    const fixture = makeFixture(16, 75, 47);
    const resolution = resolve(fixture, 16, rules);
    expect(resolution.rasterTargets.size).toBeGreaterThan(0);
    for (const [key, spec] of resolution.rasterTargets) {
      expect(tileOfKey(resolution, key)?.tile.z, key).toBe(14);
      expect(spec).toEqual({ size: 256 });
    }
    expect(resolution.targets.filter((t) => t.tile.z === 16).every((t) => !resolution.rasterTargets.has(visibleTileKey(t)))).toBe(true);
    const defaultResolution = resolve(fixture, 16);
    expect(defaultResolution.rasterTargets.size, "the default draws its far rings from textures").toBeGreaterThan(0);
    expect(
      defaultResolution.targets.filter((t) => t.tile.z === 16).every((t) => !defaultResolution.rasterTargets.has(visibleTileKey(t))),
      "the default draws the exact tiles as geometry",
    ).toBe(true);
  });

  test("the raster size is normalized", () => {
    const rules: FlatRingRules = {
      rules: [flatRingRule(0, 1), flatRingRule(1, 2, { rasterSize: 300 }), flatRingRule(2, 3, { rasterSize: 1 }), flatRingRule(3, 4, { rasterSize: 100_000 })],
    };
    expect(FlatRingRules.normalized(rules).rules.map((rule) => rule.rasterSize)).toEqual([undefined, 256, 64, 1024]);
    expect(FlatRingRules.rasterSizes.every((size) => (size & (size - 1)) === 0), "powers of two").toBe(true);
  });

  // The look-at tile and its squares

  test("the square is the look-at tile and its rings", () => {
    for (const zoom of [3, 9, 16]) {
      const fixture = makeFixture(zoom, 60, 33);
      const tile = FlatRingRuleCoverage.lookAtTile(zoom, fixture.flatRenderState);
      const r = rect({ tile: { x: tile.x, y: tile.y, z: zoom }, worldWrap: 0 }, fixture);
      expect(r.minX <= 1e-4 && r.maxX >= -1e-4 && r.minY <= 1e-4 && r.maxY >= -1e-4, `z${zoom}: the look-at tile holds the origin`).toBe(true);
      const size = r.maxX - r.minX;
      const alone = FlatRingRuleCoverage.square(0, zoom, fixture.flatRenderState);
      expect(Math.abs(alone.minX - r.minX)).toBeLessThanOrEqual(1e-4);
      expect(Math.abs(alone.maxY - r.maxY)).toBeLessThanOrEqual(1e-4);
      const three = FlatRingRuleCoverage.square(3, zoom, fixture.flatRenderState);
      expect(Math.abs(three.maxX - three.minX - size * 7)).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(three.maxY - three.minY - size * 7)).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(three.minX - (r.minX - size * 3))).toBeLessThanOrEqual(1e-3);
    }
  });

  // The coverage

  test("a band is the footprint inside its square", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 2)] };
    for (const pitchDegrees of [0, 40, 64, 75]) {
      for (let bearingDegrees = 0; bearingDegrees < 360; bearingDegrees += 17) {
        const fixture = makeFixture(15.07, pitchDegrees, bearingDegrees);
        const resolution = resolve(fixture, 15, rules);
        const square = FlatRingRuleCoverage.square(2, 15, fixture.flatRenderState);
        const inView = FlatTileCoverage.tiles(15, fixture.polygon, fixture.flatRenderState);
        const expected = inView.filter((tile) => lies(rect(tile, fixture), square));
        expect(keySet(resolution.targets), `pitch ${pitchDegrees} bearing ${bearingDegrees}`).toEqual(keySet(expected));
        expect(expected.length).toBeGreaterThan(0);
        expect(resolution.targets.length).toBeLessThanOrEqual(25);
      }
    }
  });

  /** Whether the tile has ground in the band of its own zoom's rule: inside the rule's square and outside the previous rule's. */
  function bandHolds(tile: VisibleTile, rules: FlatRingRules, fixture: Fixture): boolean {
    const r = rect(tile, fixture);
    let inner: FlatRingSquare | undefined;
    for (const rule of FlatRingRules.normalized(rules).rules) {
      const square = FlatRingRuleCoverage.square(rule.distance, 15, fixture.flatRenderState);
      if (15 - rule.zoomDrop !== tile.tile.z) {
        inner = square;
        continue;
      }
      const pieces = FlatRingRuleCoverage.bandPolygons(fixture.polygon, square, inner, (r.maxX - r.minX) * 0.01);
      return pieces.some((piece) => piece.intersects(r.minX, r.minY, r.maxX, r.maxY));
    }
    return false;
  }

  test("a turn only changes what the footprint holds", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(1, 5), flatRingRule(3, 23)] };
    const bearings: number[] = [];
    for (let bearing = 0; bearing < 360; bearing += 9) bearings.push(bearing);
    const fixtures = bearings.map((bearing) => makeFixture(15.07, 70, bearing));
    const placed = fixtures.map((fixture) => new Map(resolve(fixture, 15, rules).targets.map((t) => [visibleTileKey(t), t] as const)));
    const everPlaced = new Map<string, VisibleTile>();
    for (const tiles of placed) for (const [key, tile] of tiles) everPlaced.set(key, tile);
    expect(everPlaced.size, "the turn brings tiles in and out").toBeGreaterThan(placed[0]!.size);
    fixtures.forEach((fixture, index) => {
      for (const [key, tile] of everPlaced) {
        if (placed[index]!.has(key)) continue;
        // Drawn in by the band's inset the tile may still touch the footprint
        // along an edge: what it must not do is reach into it.
        const r = rect(tile, fixture);
        const inset = (r.maxX - r.minX) * 0.01;
        const reachesIn = fixture.polygon.intersects(r.minX + inset, r.minY + inset, r.maxX - inset, r.maxY - inset) && bandHolds(tile, rules, fixture);
        expect(reachesIn, `bearing ${bearings[index]}: ${key} is in view in its band and not placed`).toBe(false);
      }
    });
  });

  test("a street tilt places each rule's band", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 0), flatRingRule(1, 2), flatRingRule(4, 40)] };
    const fixture = makeFixture(16, 75, 47);
    const resolution = resolve(fixture, 16, rules);
    expect(resolution.bands.map((band) => band.zoom)).toEqual([16, 15, 12]);
    expect(resolution.bands.map((band) => band.distance)).toEqual([0, 2, 40]);
    expect(resolution.bands[0]!.tileCount, "the look-at tile alone").toBe(1);
    expect(resolution.bands.every((band) => band.tileCount > 0), "every rule has ground at a street tilt").toBe(true);
    const squares = rules.rules.map((rule) => FlatRingRuleCoverage.square(rule.distance, 16, fixture.flatRenderState));
    for (const target of resolution.targets) {
      const index = rules.rules.findIndex((rule) => 16 - rule.zoomDrop === target.tile.z);
      expect(index, `${visibleTileKey(target)} is at a rule's zoom`).toBeGreaterThanOrEqual(0);
      const r = rect(target, fixture);
      expect(overlap(r, squares[index]!), `${visibleTileKey(target)} reaches into its rule's square`).toBe(true);
      if (index > 0) expect(lies(r, squares[index - 1]!), `${visibleTileKey(target)} is not wholly under the nearer band`).toBe(false);
      expect(meetsFootprint(target, fixture), `${visibleTileKey(target)} is in view`).toBe(true);
    }
    expect(resolution.targets, "finest first, stable").toEqual(FlatTileCoverage.sorted(resolution.targets));
    expect(keySet(resolution.targets).size).toBe(resolution.targets.length);
    expect(resolution.targets.length, "a few tiles per band").toBeLessThanOrEqual(40);
    const again = resolve(fixture, 16, rules);
    expect(again.targets, "deterministic").toEqual(resolution.targets);
    expect(again.bands).toEqual(resolution.bands);
  });

  test("the bands cover the footprint inside the last square", () => {
    const rules: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 6), flatRingRule(4, 30)] };
    for (const bearingDegrees of [0, 36, 89, 200]) {
      const fixture = makeFixture(15.07, 70, bearingDegrees);
      const resolution = resolve(fixture, 15, rules);
      const rects = resolution.targets.map((target) => rect(target, fixture));
      const last = FlatRingRuleCoverage.square(30, 15, fixture.flatRenderState);
      const ground = FlatRingRuleCoverage.clipped(fixture.polygon, last);
      expect(ground).toBeDefined();
      const vertices = ground!.vertices;
      const centroid: Vec2 = [vertices.reduce((sum, v) => sum + v[0], 0) / vertices.length, vertices.reduce((sum, v) => sum + v[1], 0) / vertices.length];
      let samples = 0;
      for (let index = 0; index < vertices.length; index++) {
        const a = vertices[index]!;
        const b = vertices[(index + 1) % vertices.length]!;
        for (let u = 0.05; u <= 0.95 + 1e-9; u += 0.15) {
          for (let v = 0.05; v <= 0.95 + 1e-9; v += 0.15) {
            const px = centroid[0] + (a[0] + (b[0] - a[0]) * u - centroid[0]) * v;
            const py = centroid[1] + (a[1] + (b[1] - a[1]) * u - centroid[1]) * v;
            samples += 1;
            const covered = rects.some((r) => px >= r.minX - 1e-3 && px <= r.maxX + 1e-3 && py >= r.minY - 1e-3 && py <= r.maxY + 1e-3);
            expect(covered, `bearing ${bearingDegrees}: (${px}, ${py}) is in view inside the last square and under no tile`).toBe(true);
          }
        }
      }
      expect(samples).toBeGreaterThan(100);
    }
  });

  test("the last rule is the reach", () => {
    const fixture = makeFixture(16, 75);
    const short: FlatRingRules = { rules: [flatRingRule(0, 1), flatRingRule(2, 3)] };
    const long: FlatRingRules = { rules: [...short.rules, flatRingRule(5, 60)] };
    const shortResolution = resolve(fixture, 16, short);
    const longResolution = resolve(fixture, 16, long);
    expect(shortResolution.targets.length).toBeLessThan(longResolution.targets.length);
    expect(keySet(shortResolution.targets), "the shared rules place the same tiles").toEqual(keySet(longResolution.targets.filter((t) => t.tile.z >= 14)));
    const reach = FlatRingRuleCoverage.square(3, 16, fixture.flatRenderState);
    for (const target of shortResolution.targets) expect(overlap(rect(target, fixture), reach), `${visibleTileKey(target)} is not beyond the last rule`).toBe(true);
  });

  test("the drop is floored by the backdrop", () => {
    const fixture = makeFixture(3, 75);
    const deep: FlatRingRules = { rules: [flatRingRule(0, 0), flatRingRule(8, 7)] };
    const withBackdrop = resolve(fixture, 3, deep);
    expect(withBackdrop.bands.map((band) => band.zoom)).toEqual([3, TileCulling.flatBackdropZoomLevel + 1]);
    expect(withBackdrop.targets.every((t) => t.tile.z > TileCulling.flatBackdropZoomLevel)).toBe(true);
    const without = resolve(fixture, 3, deep, null);
    expect(without.bands.map((band) => band.zoom)).toEqual([3, 0]);
    expect(without.targets.some((t) => t.tile.z === 0)).toBe(true);
  });
});
