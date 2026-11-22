// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the frame's part of the Swift `GroundReliefTests`: the heights
// read back under a point, the datum and the centre of the screen on the
// terrain, a frame off the terrain, the camera's terrain through the store,
// and the rise and the collapse over the zooms and in time. The terrain comes
// from the fakes (`makeTestRelief`), the URL source's fetches answered by hand.

import { afterEach, describe, expect, test } from "vitest";
import { CameraStateController } from "../../../camera/camera-state-controller.ts";
import { ImmersiveMapCameraState } from "../../../camera/immersive-map-camera-state.ts";
import { ImmersiveMapSettings } from "../../../configuration/immersive-map-settings.ts";
import { groundReliefSettings, type GroundReliefSettings, resolvedMaximumZoomLevel } from "../../../configuration/tile-settings.ts";
import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import { Matrix, mat4Multiply } from "../../../math/matrix.ts";
import type { Vec2, Vec3 } from "../../../math/vec.ts";
import { screenCentreGroundDepth } from "../../drawers/flat-map-surface-drawer.ts";
import { type Tile, tileParentAt } from "../../tile.ts";
import { flatRingBand } from "../../visibility/flat-ring-rules.ts";
import { TileCoverageZoomPolicy } from "../../visibility/tile-coverage-zoom-policy.ts";
import { GroundReliefCameraLift } from "../lifts/ground-relief-camera-lift.ts";
import { type FakeAnswer, flatAnswer, loadUntil, makeTestRelief, type TestRelief } from "../testing/ground-relief-fakes.ts";

function expectClose(actual: number | undefined | null, expected: number, accuracy: number, message?: string): void {
  expect(actual, message).toBeDefined();
  expect(actual, message).not.toBeNull();
  expect(Math.abs(actual! - expected), message ?? `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

const made: TestRelief[] = [];
function relief(settings: GroundReliefSettings, answer: (tile: Tile) => FakeAnswer, deepestTileZoom?: number): TestRelief {
  const value = makeTestRelief(settings, answer, deepestTileZoom === undefined ? {} : { deepestTileZoom });
  made.push(value);
  return value;
}
afterEach(() => {
  for (const value of made.splice(0)) value.store.destroy();
});

/** Asks for the tile's terrain, as frames do, until some terrain over it is in (the Swift `waitForRelief`). */
async function waitForRelief(ground: TestRelief, tiles: readonly Tile[], tile: Tile): Promise<boolean> {
  return loadUntil(ground, tiles, () => ground.state.frame.reliefOfZoom(tile, tile.z) !== undefined);
}

const tile: Tile = { x: 9647, y: 12321, z: 15 };
const tilesCount = 2 ** 15;
const middleOf = (t: Tile, u = 0.5, v = 0.5): Vec2 => [(t.x + u) / 2 ** t.z, (t.y + v) / 2 ** t.z];
const centre = middleOf(tile);
const unitsPerMetreAt = (point: Vec2, renderMapSize: number) =>
  Math.fround(ImmersiveMapProjection.worldUnitsPerMeter(ImmersiveMapProjection.latitudeFromNormalizedWorldY(point[1]), renderMapSize));
const level100 = () => flatAnswer(100);

/** Settings whose tiles go to zoom 16, as the Swift tests' `coverage.maximumZoomLevel = 16`. */
const deepTo16 = ImmersiveMapSettings.default.tileMaximumZoomLevel(16);
const tileZoom = (zoom: number) => TileCoverageZoomPolicy.resolve(zoom, "flat", 16).baseZoom;

describe("GroundReliefFrame, the heights under a point", () => {
  test("the elevation under a point is read back bilinearly", async () => {
    const ground = relief(groundReliefSettings({ isEnabled: true, minimumSourceZoom: 15 }), () => ({ metres: [0, 100, 0, 100] }));
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    expectClose(ground.state.frame.elevation(middleOf(tile, 0.625), 15), 75, 0.01);
    expect(ground.state.frame.elevation([0.1, 0.1], 15), "terrain not in yet").toBeUndefined();
  });

  test("the terrain under the point looked at is the datum", async () => {
    const ground = relief(groundReliefSettings({ isEnabled: true, exaggeration: 2, minimumSourceZoom: 15, cameraTerrainZoom: 15, cameraClearanceMetres: 30 }), level100);
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    const datum = GroundReliefCameraLift.datumMetres(ground.state.frame, centre, 16);
    expectClose(datum, 100, 0.01, "the terrain's own metres, before the exaggeration");
    ground.state.setDatum(datum!);
    expect(ground.state.frame.datumMetres).toBe(datum);
  });

  test("the centre of the screen meets the terrain, not the plane", async () => {
    // Outside a frame the ring of zoom 16 reads its own terrain, and the zoom 15 tile in stands in for it.
    const ground = relief(groundReliefSettings({ isEnabled: true, exaggeration: 2, minimumSourceZoom: 15 }), level100);
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    const renderMapSize = 1_000_000;
    const unitsPerMetre = unitsPerMetreAt(centre, renderMapSize);
    // The camera 1000 m up, looking at the origin at a 60 degree pitch.
    const eye: Vec3 = [0, -1000 * unitsPerMetre * Math.tan(Math.PI / 3), 1000 * unitsPerMetre];
    const cameraMatrix = mat4Multiply(
      new Float64Array(16),
      Matrix.perspectiveMatrix(new Float64Array(16), 1, 1, 0.01, 100),
      Matrix.lookAt(new Float64Array(16), eye, [0, 0, 0], [0, 0, 1]),
    );
    const planeDepth = screenCentreGroundDepth(cameraMatrix);
    // The frame's rise a metre, at the centre's latitude.
    ground.state.setWorldScale(centre, renderMapSize);
    const depth = GroundReliefCameraLift.centreGroundDepth(ground.state.frame, cameraMatrix, centre, 16, renderMapSize);
    // Along a ray at 60 degrees from the vertical, 200 m of height are 200 / cos(60) = 400 m of depth.
    expectClose(depth, planeDepth - 400 * unitsPerMetre, unitsPerMetre);
    ground.state.setDatum(100);
    const fromTheDatum = GroundReliefCameraLift.centreGroundDepth(ground.state.frame, cameraMatrix, centre, 16, renderMapSize);
    expectClose(fromTheDatum, planeDepth, unitsPerMetre);
    expect(GroundReliefCameraLift.centreGroundDepth(ground.state.frame, cameraMatrix, centre, 9, renderMapSize), "over tiles below the relief's zoom, the plane's").toBeUndefined();
  });

  test("a frame off the terrain lies on the plane", async () => {
    const ground = relief(groundReliefSettings({ isEnabled: true, appearZoom: 12, minimumSourceZoom: 10 }), level100);
    const coarse: Tile = { x: 9647 >> 4, y: 12321 >> 4, z: 11 };
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    expect(await waitForRelief(ground, [tile, coarse], coarse), "on the terrain a coarse far tile rises too").toBe(true);
    expect(ground.state.frame.elevation(centre, 15)).toBe(100);
    ground.state.setActive(false);
    expect(ground.state.frame.reliefOfZoom(tile, tile.z), "off the terrain every tile lies on the plane").toBeUndefined();
    expect(ground.state.frame.reliefOfZoom(coarse, coarse.z)).toBeUndefined();
    expect(ground.state.frame.relief(tile, tile)).toBeUndefined();
    expect(ground.state.frame.elevation(centre, 15), "the plane under a coarse frame").toBe(0);
    expect(ground.state.frame.drawnMetres(centre, 15)).toBe(0);
    ground.state.setActive(true);
    expect(GroundReliefCameraLift.datumMetres(ground.state.frame, centre, 11), "the relief over coarse tiles is drawn from the plane").toBe(0);
    expect(GroundReliefCameraLift.datumMetres(ground.state.frame, centre, 16)).toBe(100);
  });
});

describe("GroundReliefFrameState, the camera's terrain", () => {
  const camera = deepTo16.cameraSettings({ maximumZoom: 22 });
  const reliefSettings = (): GroundReliefSettings => ({ ...camera.groundRelief({ isEnabled: true, appearZoom: 12 }).tiles.groundRelief, minimumSourceZoom: 15, cameraTerrainZoom: 15 });

  test("a pan uphill through the store's terrain keeps the eye's altitude", async () => {
    // The west column at sea level, the east at 300 m: a slope the eye at this zoom stands well over.
    const ground = relief(reliefSettings(), () => ({ metres: [0, 300, 0, 300] }), 16);
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    const west = middleOf(tile, 0.3);
    const east = middleOf(tile, 0.7);
    const controller = new CameraStateController(camera.camera);
    controller.setCameraState(ImmersiveMapCameraState.make(west, 16.5, 0, 0.5));
    const follow = ground.state.makeTerrainFollow(tileZoom, camera.presentation.globeRadiusScale, () => controller.cameraState.zoom);
    controller.terrainFollow = follow;
    const westMetres = follow.terrainMetres(west)!;
    const eastMetres = follow.terrainMetres(east)!;
    expect(eastMetres, "the slope rises eastward").toBeGreaterThan(westMetres + 200);
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(west[1]);
    const altitudeBefore = westMetres + follow.eyeHeightMetres(16.5, 0.5, latitude);

    const followed = controller.followTerrain(west, east, follow);
    expect(followed.zoom, "uphill the arm shortens: a deeper zoom").toBeGreaterThan(16.5);
    const altitudeAfter = follow.terrainMetres(followed.center)! + follow.eyeHeightMetres(followed.zoom, 0.5, latitude);
    expectClose(altitudeAfter, altitudeBefore, 1, "the eye keeps its altitude");

    controller.setCameraState(ImmersiveMapCameraState.make(west, 11.5, 0, 0.5));
    expect(follow.terrainMetres(east), "below the relief's zoom the terrain is the plane").toBe(0);
  });

  test("a drag uphill in small steps keeps the eye's altitude", async () => {
    // The north row at 300 m, the south at sea level: a slope rising north. The tiles around it, where the eye stands, are flat.
    const ground = relief(reliefSettings(), (asked) => (asked.z === 15 && asked.x === 9647 && asked.y === 12321 ? { metres: [300, 300, 0, 0] } : flatAnswer(0)), 16);
    const below: Tile = { x: 9647, y: 12322, z: 15 };
    expect(await waitForRelief(ground, [tile, below], tile)).toBe(true);
    expect(await waitForRelief(ground, [tile, below], below)).toBe(true);
    const south = middleOf(tile, 0.5, 0.8);

    const controller = new CameraStateController(camera.camera);
    controller.setCameraState(ImmersiveMapCameraState.make(south, 16.5, 0, 1.1));
    const follow = ground.state.makeTerrainFollow(tileZoom, camera.presentation.globeRadiusScale, () => controller.cameraState.zoom);
    controller.terrainFollow = follow;
    const altitude = (): number => {
      const state = controller.cameraState;
      const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(state.centerWorldMercator[1]);
      return follow.terrainMetres(state.centerWorldMercator)! + follow.eyeHeightMetres(state.zoom, state.pitch, latitude);
    };
    const eyeGround = (): Vec2 => {
      const state = controller.cameraState;
      const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(state.centerWorldMercator[1]);
      return follow.eyeGround(state.centerWorldMercator, state.zoom, state.pitch, state.bearing, latitude);
    };
    const altitudeBefore = altitude();
    const steps: number[] = [];
    for (let step = 0; step < 40; step++) {
      const before = eyeGround();
      controller.pan(0, 4, 1);
      steps.push((before[1] - eyeGround()[1]) * tilesCount);
      expect(follow.terrainMetres(controller.cameraState.centerWorldMercator), "on the terrain").not.toBeNull();
    }
    const state = controller.cameraState;
    expect(state.centerWorldMercator[1], "the drag went north, uphill").toBeLessThan(south[1] - 0.2 / tilesCount);
    const firstStep = steps[0]!;
    expectClose(steps.at(-1), firstStep, firstStep * 0.02, `the eye takes the same step over the map up the slope as at its foot: ${steps.join(", ")}`);
    expect(state.zoom, "uphill the zoom deepens").toBeGreaterThan(16.5);
    expectClose(altitude(), altitudeBefore, 1, "the eye keeps its altitude");
  });
});

describe("GroundReliefFrameState, the rise and the collapse", () => {
  test("the relief collapses at the collapse zoom", async () => {
    const settings = deepTo16.groundRelief({ isEnabled: true, exaggeration: 2, collapseZoom: 14, transitionSeconds: 0.4 });
    expect(ImmersiveMapSettings.default.tiles.groundRelief.collapseZoom, "13.7 by default").toBe(13.7);
    expect(ImmersiveMapSettings.default.tiles.groundRelief.transitionSeconds).toBe(0.3);
    const reliefOf = (collapseZoom: number): GroundReliefSettings => ({ ...settings.tiles.groundRelief, collapseZoom, minimumSourceZoom: 15, cameraTerrainZoom: 15 });
    const ground = relief(reliefOf(14), level100);
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    // The camera's terrain is the fixture's zoom 15 map, so the camera stays over the fixture's tile while it collapses.
    let cameraZoom = 16;
    const follow = ground.state.makeTerrainFollow(tileZoom, settings.presentation.globeRadiusScale, () => cameraZoom);
    const strength = () => ground.state.frame.strengthAt(centre, 15)!;
    const state = ground.state;
    state.setFrame(13.9, undefined, 1 / 60);
    expect(strength(), "full below the collapse zoom").toBe(2);
    expect(state.isVisible(13.9)).toBe(true);
    expect(state.isTransitioning).toBe(false);
    state.setFrame(14, undefined, 0.2);
    expectClose(state.standingShare, 0.5, 1e-6, "halfway down after half the time");
    expectClose(strength(), 1, 1e-6, "eased: half the share is half the strength");
    expect(state.isTransitioning).toBe(true);
    expect(state.isVisible(14), "still on the terrain on the way down").toBe(true);
    expectClose(follow.terrainMetres(centre), 100, 1e-3, "the camera's terrain scales with it");
    state.setFrame(14, undefined, 0.2);
    cameraZoom = 17;
    expect(state.standingShare).toBe(0);
    expect(strength(), "collapsed").toBe(0);
    expect(state.isTransitioning).toBe(false);
    expect(state.isVisible(14), "and the frame is off the terrain once collapsed").toBe(false);
    expect(follow.terrainMetres(centre)).toBe(0);
    expect(state.frame.elevation(centre, 15), "the heights themselves are untouched").toBe(100);
    state.setFrame(13, undefined, 0.1);
    expectClose(state.standingShare, 0.25, 1e-6, "rising back at the same pace");
    expect(state.isVisible(13), "on the terrain the moment the zoom is back").toBe(true);
    state.setFrame(13, undefined, undefined, true);
    expect(strength(), "a snap settles it at once").toBe(2);
    state.setFrame(16);
    expect(strength(), "without a frame time the collapse is settled where the zoom puts it").toBe(0);

    const everywhere = relief(reliefOf(30), level100);
    expect(await waitForRelief(everywhere, [tile], tile)).toBe(true);
    everywhere.state.setFrame(20);
    expect(everywhere.state.frame.strengthAt(centre, 15), "a collapse zoom past the deepest keeps the relief at every zoom").toBe(2);
    expect(everywhere.state.isVisible(20)).toBe(true);
  });

  test("the relief collapses where the source has no terrain for the near ring", async () => {
    const settings = deepTo16.groundRelief({ isEnabled: true, appearZoom: 10, collapseZoom: 13.7 });
    expect(ImmersiveMapSettings.default.tiles.groundRelief.collapsesWhereTerrainIsMissing, "on by default").toBe(true);
    // The source stops at zoom 12, as Mapterhorn does without lidar.
    const answer = (asked: Tile): FakeAnswer => (asked.z === 13 ? "missing" : level100());
    const deepest = resolvedMaximumZoomLevel(settings.tiles.coverage);
    const ground = relief(settings.tiles.groundRelief, answer, deepest);
    const deep: Tile = { x: 4823, y: 6160, z: 13 };
    const point = middleOf(deep);
    expect(tileParentAt({ x: Math.floor(point[0] * 2 ** 15), y: Math.floor(point[1] * 2 ** 15), z: 15 }, 13)).toEqual(deep);
    const band = [flatRingBand(13, 1, 9, 13)];
    ground.state.setBands(band);
    const state = ground.state;

    state.setFrame(13.2, point);
    expect(state.standingShare, "stands on the ancestor until the source has answered").toBe(1);
    expect(await loadUntil(ground, [deep], () => state.frame.statusSnapshot().missingCount === 1 && ground.store.isResident(tileParentAt(deep, 12)!)), "the source has no zoom 13 here, and its parent is in").toBe(
      true,
    );
    state.setFrame(13.2, point);
    expect(state.standingShare, "collapsed: the near ring would draw zoom 12 stretched").toBe(0);
    expect(state.stands(13.2)).toBe(false);
    expect(state.isVisible(13.2)).toBe(false);
    state.setFrame(12.9, point);
    expect(state.standingShare, "on zoom 12's own tiles the relief stands again").toBe(1);
    state.setFrame(13.2);
    expect(state.standingShare, "without a point looked at the zoom alone decides").toBe(1);

    const onTheAncestor = relief(settings.groundRelief({ collapsesWhereTerrainIsMissing: false }).tiles.groundRelief, answer, deepest);
    onTheAncestor.state.setBands(band);
    expect(await loadUntil(onTheAncestor, [deep], () => onTheAncestor.state.frame.statusSnapshot().missingCount === 1)).toBe(true);
    onTheAncestor.state.setFrame(13.2, point);
    expect(onTheAncestor.state.standingShare, "off, the relief stands on the ancestor up to the collapse zoom").toBe(1);
  });

  test("the relief rises at the appear zoom", async () => {
    const settings = deepTo16.groundRelief({ isEnabled: true, exaggeration: 2, appearZoom: 10, collapseZoom: 15, transitionSeconds: 0.4 });
    expect(ImmersiveMapSettings.default.tiles.groundRelief.appearZoom, "10 by default").toBe(10);
    const reliefOf = (appearZoom: number): GroundReliefSettings => ({ ...settings.tiles.groundRelief, appearZoom, minimumSourceZoom: 15, cameraTerrainZoom: 15 });
    const ground = relief(reliefOf(10), level100);
    expect(await waitForRelief(ground, [tile], tile)).toBe(true);
    const follow = ground.state.makeTerrainFollow(tileZoom, settings.presentation.globeRadiusScale, () => 16);
    const state = ground.state;
    const strength = () => state.frame.strengthAt(centre, 15)!;
    state.setFrame(9.5);
    expect(strength(), "flat below the appear zoom").toBe(0);
    expect(state.isVisible(9.5), "and the frame is off the terrain there").toBe(false);
    expect(follow.terrainMetres(centre), "the camera stands on the plane").toBe(0);
    expect(state.isVisible(10)).toBe(true);
    expect(state.isVisible(14.9), "on it up to the collapse").toBe(true);
    state.setFrame(10.5, undefined, 0.2);
    expectClose(state.standingShare, 0.5, 1e-6, "halfway up after half the time");
    expectClose(strength(), 1, 1e-6, "eased: half the share is half the strength");
    expect(state.isTransitioning).toBe(true);
    expectClose(follow.terrainMetres(centre), 100, 1e-3, "the camera's terrain rises with it");
    state.setFrame(10.1, undefined, 0.2);
    expect(strength(), "full once risen, whatever the zoom within the relief's zooms").toBe(2);
    state.setFrame(12.7, undefined, 1 / 60);
    expect(strength(), "a zoom's move within them changes nothing: no breathing").toBe(2);
    state.setFrame(15);
    expect(strength(), "the collapse takes it away again on top").toBe(0);

    const atOnce = relief(reliefOf(0), level100);
    expect(await waitForRelief(atOnce, [tile], tile)).toBe(true);
    atOnce.state.setFrame(5);
    expect(atOnce.state.frame.strengthAt(centre, 15), "an appear zoom of 0 draws the relief from the plane's first frame").toBe(2);
  });

  test("the frame state tells the store's demand where the relief stands", () => {
    const ground = relief(groundReliefSettings({ isEnabled: true, appearZoom: 11.6, collapseZoom: 13.7 }), level100);
    expect(ground.state.fromTileZoom, "the tile zoom of the appear zoom").toBe(11);
    expect(ground.state.collapseTileZoom).toBe(13);
    expect(ground.store.demandFrame).toEqual({ isActive: true, fromTileZoom: 11, collapseTileZoom: 13 });
    ground.state.setActive(false);
    expect(ground.store.demandFrame.isActive).toBe(false);
  });
});
