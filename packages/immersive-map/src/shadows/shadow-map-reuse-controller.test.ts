// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A port of the Swift `ShadowMapReuseControllerTests` (the hidden buildings
// and the static model casters as keys of the caster set) and
// of the caster part of `ShadowPassGateResolverTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { SceneSettings } from "../configuration/scene-settings.ts";
import { type ImmersiveMapZoomCurve, zoomCurve } from "../configuration/zoom-curve.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { type Mat4, Matrix, mat4Multiply } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import type { ShadowCascadeSlot } from "./shadow-cascade-atlas.ts";
import { ShadowFrameState } from "./shadow-frame-state.ts";
import { ShadowMapReuseController } from "./shadow-map-reuse-controller.ts";
import type { GroundReliefShadowSignature } from "../tile/relief/frame/ground-relief-frame.ts";

const equatorCenter: Vec2 = [0.5, 0.5];
const renderMapSize = 2.0 * Math.PI * 0.14 * 2 ** 16;
const basePan: Vec2 = [0.312, -0.144];
const baseEye: Vec3 = [0.2, -0.35, 0.7];
const zoom = 16.0;
const unitsPerMeter = ImmersiveMapProjection.worldUnitsPerMeter(0, renderMapSize);

const coverage = (cameraDistances: number): ImmersiveMapZoomCurve => zoomCurve((cameraDistances * Math.hypot(...baseEye)) / unitsPerMeter);

function sceneWith(near: number, far: number, base: SceneSettings = ImmersiveMapSettings.default.scene): SceneSettings {
  return { ...base, shadows: { ...base.shadows, nearCoverageMeters: coverage(near), farCoverageMeters: coverage(far) } };
}
const scene = sceneWith(3, 12);

function makeProjectionView(eye: Vec3): Mat4 {
  const distance = Math.hypot(...eye);
  const up: Vec3 = Math.abs(eye[2] / Math.max(distance, 1e-6)) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const view = Matrix.lookAt(new Float64Array(16), eye, [0, 0, 0], up);
  const projection = Matrix.perspectiveMatrix(new Float64Array(16), 0.9, 1.5, distance * 0.01, distance * 40);
  return mat4Multiply(new Float64Array(16), projection, view);
}

function resolve(controller: ShadowMapReuseController, options: { eye?: Vec3; pan?: Vec2; scene?: SceneSettings } = {}): ShadowFrameState | undefined {
  const eye = options.eye ?? baseEye;
  return controller.resolveFrameState({
    renderSurfaceMode: "flat",
    projectionView: makeProjectionView(eye),
    cameraEye: eye,
    centerWorldMercator: equatorCenter,
    flatRenderPan: options.pan ?? basePan,
    renderMapSize,
    zoom,
    scene: options.scene ?? scene,
  });
}

const keysOf = (residents: object[]) => ShadowMapReuseController.casterKeys(residents.map((resident) => ({ resident, placeIn: { tile: { x: 0, y: 0, z: 14 }, worldWrap: 0 }, quarters: 0b1111 })));

function plan(controller: ShadowMapReuseController, casterKeys: ReadonlySet<string>, options: { models?: boolean; texture?: number; slot?: ShadowCascadeSlot; rise?: [number, number] } = {}): boolean {
  return controller.planShadowRender({
    casterKeys,
    hasModelCasters: options.models ?? false,
    heightScales: options.rise ?? [1, 1],
    textureIdentity: options.texture ?? 1,
    slot: options.slot ?? "near",
  });
}

function projectUV(m: Mat4, p: Vec3): Vec2 {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  return [x / w, y / w];
}

describe("ShadowMapReuseController", () => {
  test("a hold renders once and then reuses", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    const first = resolve(controller)!;
    expect(plan(controller, keys)).toBe(true);
    const second = resolve(controller)!;
    expect(plan(controller, keys)).toBe(false);
    expect(first.lightProjectionView).toEqual(second.lightProjectionView);
  });

  test("a small pan reuses and keeps the content glued", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    const pan2: Vec2 = [basePan[0] + 3.7e-7, basePan[1] - 2.2e-7];
    const state1 = resolve(controller, { pan: basePan })!;
    expect(plan(controller, keys)).toBe(true);
    const state2 = resolve(controller, { pan: pan2 })!;
    expect(plan(controller, keys)).toBe(false);
    const half = renderMapSize * 0.5;
    const probe: Vec3 = [0.05, -0.1, 0];
    const shifted: Vec3 = [probe[0] + (pan2[0] - basePan[0]) * half, probe[1] - (pan2[1] - basePan[1]) * half, 0];
    const uv1 = projectUV(state1.shadowUniform.near.worldToShadowTexture, probe);
    const uv2 = projectUV(state2.shadowUniform.near.worldToShadowTexture, shifted);
    expect(Math.abs(uv1[0] - uv2[0])).toBeLessThan(1e-5);
    expect(Math.abs(uv1[1] - uv2[1])).toBeLessThan(1e-5);
  });

  test("a pan beyond the margin refits", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
    expect(resolve(controller, { pan: [basePan[0] + 1e-4, basePan[1]] })).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
  });

  test("a strong zoom-in refits for sharpness", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
    expect(resolve(controller, { eye: [baseEye[0] * 0.5, baseEye[1] * 0.5, baseEye[2] * 0.5] })).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
  });

  test("a slight zoom-out reuses", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
    expect(resolve(controller, { eye: [baseEye[0] * 1.03, baseEye[1] * 1.03, baseEye[2] * 1.03] })).toBeDefined();
    expect(plan(controller, keys)).toBe(false);
  });

  test("a change of the light refits", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
    const d: Vec3 = [0.5, 0.2, 0.8];
    const n = Math.hypot(...d);
    expect(resolve(controller, { scene: { ...scene, light: { direction: [d[0] / n, d[1] / n, d[2] / n] } } })).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
  });

  test("the rules of the caster set", () => {
    const controller = new ShadowMapReuseController();
    const staying = {};
    const departing = {};
    const arriving = {};
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keysOf([staying, departing]))).toBe(true);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keysOf([staying]))).toBe(true);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keysOf([staying]))).toBe(false);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keysOf([staying, arriving]))).toBe(true);
  });

  test("model casters always render", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys, { models: true })).toBe(true);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys, { models: true })).toBe(true);
  });

  /**
   * The mountains' map is drawn again when the terrain under it changes (a
   * tile arriving or welded, the rise, the datum), and reused while it holds.
   */
  test("the terrain changing draws the map again", () => {
    const controller = new ShadowMapReuseController();
    const none = new Set<string>();
    const planTerrain = (terrain: GroundReliefShadowSignature | undefined) =>
      controller.planShadowRender({ casterKeys: none, hasModelCasters: false, heightScales: [1, 1], textureIdentity: 1, slot: "near", terrain });
    const terrain: GroundReliefShadowSignature = { version: 1, strength: 1, worldUnitsPerMetre: 0.5, datumMetres: 1200 };
    expect(resolve(controller)).toBeDefined();
    expect(planTerrain(terrain)).toBe(true);
    expect(resolve(controller)).toBeDefined();
    expect(planTerrain(terrain), "the same terrain reuses the map").toBe(false);
    expect(planTerrain({ ...terrain }), "the same values, another object").toBe(false);
    const welded = { ...terrain, version: 2 };
    expect(planTerrain(welded)).toBe(true);
    expect(planTerrain({ ...welded, datumMetres: 1250 }), "a pan to another datum").toBe(true);
    expect(planTerrain({ ...welded, datumMetres: 1250, strength: 0.5 }), "the rise").toBe(true);
    expect(planTerrain({ ...welded, datumMetres: 1250, strength: 0.5, worldUnitsPerMetre: 0.6 }), "another latitude's scale").toBe(true);
    expect(planTerrain(undefined), "the mountains gone").toBe(true);
    expect(planTerrain(undefined)).toBe(false);
  });

  test("the rise renders the map again while it moves", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys, { rise: [0.4, 0] })).toBe(true);
    expect(plan(controller, keys, { rise: [0.8, 0] })).toBe(true);
    expect(plan(controller, keys, { rise: [0.8, 0] })).toBe(false);
  });

  test("the windows render on their own", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    const eye: Vec3 = [0, -0.7, 0.4];
    const both = sceneWith(0.5, 4);
    expect(ShadowFrameState.slots(resolve(controller, { eye, scene: both })!)).toEqual(["near", "far"]);
    expect(plan(controller, keys, { slot: "near" })).toBe(true);
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
    expect(resolve(controller, { eye, scene: sceneWith(0.25, 4) })).toBeDefined();
    expect(plan(controller, keys, { slot: "near" })).toBe(true);
    expect(plan(controller, keys, { slot: "far" })).toBe(false);
    expect(ShadowFrameState.slots(resolve(controller, { eye, scene: sceneWith(0.5, 0.5) })!)).toEqual(["near"]);
    expect(ShadowFrameState.slots(resolve(controller, { eye, scene: both })!)).toEqual(["near", "far"]);
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
  });

  test("a change of the texture's identity forces a render", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys, { texture: 1 })).toBe(true);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys, { texture: 2 })).toBe(true);
  });

  test("a caster key names the object, the slot, the world copy and the quarters", () => {
    const resident = {};
    const placement = (worldWrap: number, quarters: number) => ({ resident, placeIn: { tile: { x: 3, y: 5, z: 15 }, worldWrap }, quarters });
    const keys = ShadowMapReuseController.casterKeys([placement(0, 0b1111), placement(1, 0b1111), placement(0, 0b0011), placement(0, 0b1111)]);
    expect(keys.size).toBe(3);
    expect(ShadowMapReuseController.casterKeys([placement(0, 0b1111)])).toEqual(ShadowMapReuseController.casterKeys([placement(0, 0b1111)]));
    expect(ShadowMapReuseController.casterKeys([{ ...placement(0, 0b1111), resident: {} }])).not.toEqual(ShadowMapReuseController.casterKeys([placement(0, 0b1111)]));
    expect(ShadowMapReuseController.casterKeys([]).size).toBe(0);
  });
});

describe("ShadowMapReuseController, the far window's deferred refit", () => {
  test("both windows stale on one frame: the near refits now, the far on the next frame", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    const eye: Vec3 = [0, -0.7, 0.4];
    const both = sceneWith(0.5, 4);
    expect(resolve(controller, { eye, scene: both })).toBeDefined();
    expect(plan(controller, keys, { slot: "near" })).toBe(true);
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
    // A pan past both margins.
    const pan: Vec2 = [basePan[0] + 2e-3, basePan[1]];
    expect(resolve(controller, { eye, scene: both, pan })).toBeDefined();
    expect(plan(controller, keys, { slot: "near" })).toBe(true);
    expect(plan(controller, keys, { slot: "far" })).toBe(false);
    expect(resolve(controller, { eye, scene: both, pan })).toBeDefined();
    expect(plan(controller, keys, { slot: "near" })).toBe(false);
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
  });
});

describe("ShadowMapReuseController, a caster change put off", () => {
  test("a window that only saw its casters change may render a frame late, never two running", () => {
    const controller = new ShadowMapReuseController();
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keysOf([{}]))).toBe(true);
    const deferred = (keys: ReadonlySet<string>) =>
      controller.planShadowRender({ casterKeys: keys, hasModelCasters: false, heightScales: [1, 1], textureIdentity: 1, slot: "near", mayDeferCasterChange: true });
    const arrived = keysOf([{}, {}]);
    expect(deferred(arrived)).toBe(false);
    expect(deferred(arrived)).toBe(true);
    expect(deferred(arrived)).toBe(false);
  });

  test("a fresh fit is never put off", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    expect(resolve(controller)).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
    expect(resolve(controller, { pan: [basePan[0] + 1e-4, basePan[1]] })).toBeDefined();
    expect(controller.planShadowRender({ casterKeys: keys, hasModelCasters: false, heightScales: [1, 1], textureIdentity: 1, slot: "near", mayDeferCasterChange: true })).toBe(true);
  });
});

describe("ShadowMapReuseController, the travel slack", () => {
  test("a turn of a degree reuses the rendered map", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    const turned = (degrees: number): Vec3 => {
      const a = (degrees * Math.PI) / 180;
      return [baseEye[0] * Math.cos(a) - baseEye[1] * Math.sin(a), baseEye[0] * Math.sin(a) + baseEye[1] * Math.cos(a), baseEye[2]];
    };
    expect(resolve(controller, { eye: turned(0) })).toBeDefined();
    expect(plan(controller, keys)).toBe(true);
    expect(resolve(controller, { eye: turned(1) })).toBeDefined();
    expect(plan(controller, keys)).toBe(false);
  });
});

describe("ShadowMapReuseController, a change of the casters alone", () => {
  const tileOf = (x: number) => ({ x, y: 0, z: 14 });
  const keyOf = (resident: object, x: number, riseStep = 1) => ShadowMapReuseController.casterKey({ resident, placeIn: { tile: tileOf(x), worldWrap: 0 }, quarters: 0b1111, riseStep });

  test("casters that arrive are drawn over the kept slice", () => {
    const controller = new ShadowMapReuseController();
    const a = {};
    const b = {};
    resolve(controller);
    expect(plan(controller, new Set([keyOf(a, 0)]))).toBe(true);
    expect(controller.passPlan("near")?.added).toBeUndefined();
    resolve(controller);
    expect(plan(controller, new Set([keyOf(a, 0), keyOf(b, 1)]))).toBe(true);
    expect([...controller.passPlan("near")!.added!]).toEqual([keyOf(b, 1)]);
    expect(controller.passPlan("near")!.removed).toEqual([]);
  });

  test("a caster rising a step only adds", () => {
    const controller = new ShadowMapReuseController();
    const a = {};
    resolve(controller);
    plan(controller, new Set([keyOf(a, 0, 1 / 3)]));
    resolve(controller);
    expect(plan(controller, new Set([keyOf(a, 0, 1 / 2)]))).toBe(true);
    expect([...controller.passPlan("near")!.added!]).toEqual([keyOf(a, 0, 1 / 2)]);
    expect(controller.passPlan("near")!.removed).toEqual([]);
  });

  test("casters that leave, or stand lower, are removals", () => {
    const controller = new ShadowMapReuseController();
    const a = {};
    const b = {};
    resolve(controller);
    plan(controller, new Set([keyOf(a, 0), keyOf(b, 1, 1 / 2)]));
    resolve(controller);
    expect(plan(controller, new Set([keyOf(b, 1, 1 / 3)]))).toBe(true);
    const passPlan = controller.passPlan("near")!;
    expect([...passPlan.added!]).toEqual([keyOf(b, 1, 1 / 3)]);
    expect([...passPlan.removed].sort()).toEqual([keyOf(a, 0), keyOf(b, 1, 1 / 2)].sort());
  });

  test("more than the casters changing clears the slice", () => {
    const controller = new ShadowMapReuseController();
    const a = {};
    resolve(controller);
    plan(controller, new Set([keyOf(a, 0)]), { rise: [1, 1] });
    resolve(controller);
    expect(plan(controller, new Set([keyOf(a, 0), keyOf({}, 1)]), { rise: [0.5, 1] })).toBe(true);
    expect(controller.passPlan("near")?.added).toBeUndefined();
  });

  test("a whole redraw replaces a plan with removals", () => {
    const controller = new ShadowMapReuseController();
    const a = {};
    resolve(controller);
    plan(controller, new Set([keyOf(a, 0)]));
    resolve(controller);
    plan(controller, new Set([keyOf({}, 1)]));
    expect(controller.passPlan("near")?.removed.length).toBe(1);
    controller.redrawWhole("near");
    expect(controller.passPlan("near")).toEqual({ added: undefined, removed: [], hole: undefined });
  });

  test("a key says where its caster stands", () => {
    expect(ShadowMapReuseController.casterPlace(ShadowMapReuseController.casterKey({ resident: {}, placeIn: { tile: { x: 9648, y: 12318, z: 15 }, worldWrap: -1 }, quarters: 0b0110 }))).toEqual({
      tile: { x: 9648, y: 12318, z: 15 },
      worldWrap: -1,
    });
  });
});

describe("ShadowMapReuseController, the far window's caster hole", () => {
  test("the far window leaves out a disc about the camera inside the near window's reach", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    resolve(controller);
    plan(controller, keys, { slot: "near" });
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
    expect(controller.passPlan("near")!.hole).toBeUndefined();
    const hole = controller.passPlan("far")!.hole!;
    // Centred on the camera's ground point, in the frame's flat world.
    expect(hole.x).toBeCloseTo(baseEye[0], 9);
    expect(hole.y).toBeCloseTo(baseEye[1], 9);
    // Inside where the receivers start reading the far window (the near radius's fade start).
    const nearRadius = 3 * Math.hypot(...baseEye);
    expect(hole.radius).toBeGreaterThan(0);
    expect(hole.radius).toBeLessThan(nearRadius * 0.75 * ShadowMapReuseController.farCasterHoleShare);
  });

  test("the hole moves with the pan, glued to the map", () => {
    const controller = new ShadowMapReuseController();
    resolve(controller);
    plan(controller, keysOf([{}]), { slot: "far" });
    const hole = controller.passPlan("far")!.hole!;
    expect(hole.x).toBeCloseTo(baseEye[0], 9);
    const pan: Vec2 = [basePan[0] + 1e-6, basePan[1]];
    resolve(controller, { pan });
    const keys = keysOf([{}]);
    plan(controller, keys, { slot: "far" });
    // A new caster set redraws with the hole the slice was drawn with, moved by the pan.
    plan(controller, new Set([...keys, ...keysOf([{}])]), { slot: "far" });
    const moved = controller.passPlan("far")!.hole!;
    expect(moved.x - hole.x).toBeCloseTo(1e-6 * renderMapSize * 0.5, 9);
    expect(moved.radius).toBe(hole.radius);
  });

  test("a near window shrunk past the hole draws the far window again, its fit kept", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    resolve(controller);
    plan(controller, keys, { slot: "near" });
    plan(controller, keys, { slot: "far" });
    // The same far window: a near window of a third of the radius reads the far one over most of the hole.
    resolve(controller, { scene: sceneWith(1, 12) });
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
    expect(controller.passPlan("far")!.added).toBeUndefined();
    // The hole it draws now fits the smaller near window, or there is none.
    const hole = controller.passPlan("far")!.hole;
    expect(hole === undefined || hole.radius < Math.hypot(...baseEye) * 0.75).toBe(true);
    resolve(controller, { scene: sceneWith(1, 12) });
    expect(plan(controller, keys, { slot: "far" })).toBe(false);
  });
  test("a building tile with buildings left out for a model casts as another caster", () => {
    // The tile draws from its working buffer, whose identity is the caster's.
    const controller = new ShadowMapReuseController();
    const tile = {};
    const working = {};
    resolve(controller);
    expect(plan(controller, keysOf([tile]))).toBe(true);
    resolve(controller);
    // The hidden building's shadow is still in the map.
    expect(plan(controller, keysOf([working]))).toBe(true);
    expect(controller.passPlan("near")?.removed.length).toBe(1);
    resolve(controller);
    expect(plan(controller, keysOf([working]))).toBe(false);
    resolve(controller);
    // The building is back and its shadow is not in the map.
    expect(plan(controller, keysOf([tile]))).toBe(true);
  });

  test("static model casters render only when their set changes", () => {
    const controller = new ShadowMapReuseController();
    const building = {};
    const modelTile = {};
    const otherModelTile = {};
    resolve(controller);
    expect(plan(controller, keysOf([building, modelTile]))).toBe(true);
    resolve(controller);
    // A tile of models that do not move is in the map already.
    expect(plan(controller, keysOf([building, modelTile]))).toBe(false);
    resolve(controller);
    expect(plan(controller, keysOf([building, modelTile, otherModelTile]))).toBe(true);
    // Only the arrival is drawn, over the kept slice.
    expect(controller.passPlan("near")?.added?.size).toBe(1);
    expect(controller.passPlan("near")?.removed).toEqual([]);
  });
});

describe("ShadowMapReuseController, the step of the world's size at a whole zoom", () => {
  // The same camera over the same ground, one whole zoom in: the flat world
  // is twice the size, and every length of the frame with it.
  const frame = (scale: number) => {
    const eye: Vec3 = [baseEye[0] * scale, baseEye[1] * scale, baseEye[2] * scale];
    return {
      renderSurfaceMode: "flat" as const,
      projectionView: makeProjectionView(eye),
      cameraEye: eye,
      centerWorldMercator: equatorCenter,
      flatRenderPan: [basePan[0] * scale, basePan[1] * scale] as Vec2,
      renderMapSize: renderMapSize * scale,
      zoom: zoom + Math.log2(scale),
      scene,
    };
  };

  test.each([2, 0.5])("both windows are fitted afresh in the new units, the far one not put off (x%s)", (scale) => {
    const kept = new ShadowMapReuseController();
    kept.resolveFrameState(frame(1));
    const stepped = kept.resolveFrameState(frame(scale))!;
    const fresh = new ShadowMapReuseController().resolveFrameState(frame(scale))!;
    expect(stepped.farLightProjectionView).toBeDefined();
    expect(Array.from(stepped.lightProjectionView)).toEqual(Array.from(fresh.lightProjectionView));
    expect(Array.from(stepped.farLightProjectionView!)).toEqual(Array.from(fresh.farLightProjectionView!));
  });

  test("both slices are drawn again on that frame, whole", () => {
    const controller = new ShadowMapReuseController();
    const keys = keysOf([{}]);
    controller.resolveFrameState(frame(1));
    expect(plan(controller, keys, { slot: "near" })).toBe(true);
    expect(plan(controller, keys, { slot: "far" })).toBe(true);
    controller.resolveFrameState(frame(2));
    for (const slot of ["near", "far"] as const) {
      expect(plan(controller, keys, { slot })).toBe(true);
      expect(controller.passPlan(slot)?.added).toBeUndefined();
    }
  });
});
