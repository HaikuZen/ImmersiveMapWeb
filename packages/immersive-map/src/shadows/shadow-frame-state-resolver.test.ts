// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A port of the Swift `ShadowFrameStateResolverTests`.

import { describe, expect, test } from "vitest";
import type { ViewMode } from "../camera/view-mode.ts";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { type SceneSettings, type ShadowSettings, shadowNearCoverageMeters, shadowStrength } from "../configuration/scene-settings.ts";
import { type ImmersiveMapZoomCurve, zoomCurve, zoomCurveValue } from "../configuration/zoom-curve.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { mat4Invert } from "../math/mat4-invert.ts";
import { type Mat4, Matrix, mat4Multiply } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import { ShadowFrameState } from "./shadow-frame-state.ts";
import { ShadowFrameStateResolver } from "./shadow-frame-state-resolver.ts";
import { ShadowCascadeUniform } from "./shadow-uniform.ts";

const R = ShadowFrameStateResolver;
const equatorCenter: Vec2 = [0.5, 0.5];
const renderMapSize = 2.0 * Math.PI * 0.14 * 2 ** 16;
const zoom = 16.0;
const unitsPerMeter = ImmersiveMapProjection.worldUnitsPerMeter(0, renderMapSize);
const defaultScene = ImmersiveMapSettings.default.scene;

const length3 = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const metersOf = (cameraDistances: number, eye: Vec3) => (cameraDistances * length3(eye)) / unitsPerMeter;
const coverage = (cameraDistances: number, eye: Vec3): ImmersiveMapZoomCurve => zoomCurve(metersOf(cameraDistances, eye));
const radiusOf = (curve: ImmersiveMapZoomCurve) => zoomCurveValue(curve, zoom, "geometric") * unitsPerMeter;

function withShadows(change: Partial<{ -readonly [K in keyof ShadowSettings]: ShadowSettings[K] }>, scene: SceneSettings = defaultScene): SceneSettings {
  return { ...scene, shadows: { ...scene.shadows, ...change } };
}

function withLight(direction: Vec3, scene: SceneSettings = defaultScene): SceneSettings {
  return { ...scene, light: { direction } };
}

function makeEye(pitch: number, bearing: number, distance: number): Vec3 {
  return [Math.sin(bearing) * Math.sin(pitch) * distance, -Math.cos(bearing) * Math.sin(pitch) * distance, Math.cos(pitch) * distance];
}

/** A plausible camera matrix for the eye, looking at the origin. */
function makeProjectionView(eye: Vec3): Mat4 {
  const distance = length3(eye);
  const d = Math.max(distance, 1e-6);
  const up: Vec3 = Math.abs(eye[2] / d) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const view = Matrix.lookAt(new Float64Array(16), eye, [0, 0, 0], up);
  const projection = Matrix.perspectiveMatrix(new Float64Array(16), 0.9, 1.5, distance * 0.01, distance * 40);
  return mat4Multiply(new Float64Array(16), projection, view);
}

function resolve(
  options: { renderSurfaceMode?: ViewMode; eye?: Vec3; flatRenderPan?: Vec2; scene?: SceneSettings; zoom?: number } = {},
): ShadowFrameState | undefined {
  const eye = options.eye ?? [0.2, -0.35, 0.7];
  return R.resolve({
    renderSurfaceMode: options.renderSurfaceMode ?? "flat",
    projectionView: makeProjectionView(eye),
    cameraEye: eye,
    centerWorldMercator: equatorCenter,
    flatRenderPan: options.flatRenderPan ?? [0.312, -0.144],
    renderMapSize,
    zoom: options.zoom ?? zoom,
    scene: options.scene ?? defaultScene,
  });
}

function must<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value!;
}

function project(m: Mat4, p: Vec3): Vec3 {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!;
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  return [x / w, y / w, z / w];
}

function inverseOf(m: Mat4): Mat4 {
  const out = new Float64Array(16);
  expect(mat4Invert(out, m)).toBe(true);
  return out;
}

/** A deterministic generator for the property test (SplitMix64, as the Swift test seeds). */
function splitMix64(seed: bigint): () => number {
  let state = seed;
  const mask = (1n << 64n) - 1n;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & mask;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    z = z ^ (z >> 31n);
    return Number(z >> 11n) / 2 ** 53;
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

describe("gates", () => {
  test("disabled shadows return nothing", () => {
    expect(resolve({ scene: withShadows({ isEnabled: false }) })).toBeUndefined();
    expect(resolve({ scene: withShadows({ strength: zoomCurve(0) }) })).toBeUndefined();
  });

  test("the spherical mode returns nothing", () => {
    expect(resolve({ renderSurfaceMode: "spherical" })).toBeUndefined();
  });

  test("a horizontal or degenerate light returns nothing", () => {
    expect(resolve({ scene: withLight([1, 1, 0.01]) })).toBeUndefined();
    expect(resolve({ scene: withLight([0.3, 0.3, -1]) })).toBeUndefined();
    expect(resolve({ scene: withLight([0, 0, 0]) })).toBeUndefined();
  });

  test("the strength and the resolution are clamped", () => {
    const state = must(resolve({ scene: withShadows({ strength: zoomCurve(3), mapResolution: 100_000 }) }));
    expect(state.shadowUniform.strength).toBe(1);
    expect(state.mapResolution).toBe(4096);
    expect(must(resolve({ scene: withShadows({ strength: zoomCurve(3), mapResolution: 16 }) })).mapResolution).toBe(256);
  });
});

describe("the window's fit", () => {
  test("the visible ground and its casters stay inside the window", () => {
    const random = splitMix64(0x5ad011fen);
    const range = (a: number, b: number) => a + (b - a) * random();
    for (let iteration = 0; iteration < 30; iteration++) {
      const pitch = range(0, (75 * Math.PI) / 180);
      const bearing = range(0, 2 * Math.PI);
      const distance = range(0.5, 1.0);
      const raw: Vec3 = [range(-1, 1), range(-1, 1), range(0.15, 1.2)];
      const light: Vec3 = [raw[0] / length3(raw), raw[1] / length3(raw), raw[2] / length3(raw)];
      const eye = makeEye(pitch, bearing, distance);
      const scene = withLight(light);
      const state = must(resolve({ eye, scene }));
      const spec = R.windowSpec(shadowNearCoverageMeters(scene.shadows, zoom), unitsPerMeter, scene.shadows.maxCasterHeightMeters);
      const footprint = R.visibleGroundFootprint(inverseOf(makeProjectionView(eye)), eye, spec.radius);
      expect(footprint.length).toBeGreaterThan(0);
      const tolerance = 1e-3;
      for (const point of footprint) {
        for (const z of [0, spec.maxCasterHeight]) {
          const ndc = project(state.lightProjectionView, [point[0], point[1], z]);
          expect(Math.abs(ndc[0])).toBeLessThanOrEqual(1 + tolerance);
          expect(Math.abs(ndc[1])).toBeLessThanOrEqual(1 + tolerance);
          expect(ndc[2]).toBeGreaterThanOrEqual(-tolerance);
          expect(ndc[2]).toBeLessThanOrEqual(1 + tolerance);
        }
        const lift = spec.maxCasterHeight / light[2];
        const caster: Vec3 = [point[0] + light[0] * lift, point[1] + light[1] * lift, light[2] * lift];
        expect(project(state.lightProjectionView, caster)[2]).toBeGreaterThanOrEqual(-tolerance);
      }
    }
  });

  test("the window's depth spans the relief's heights", () => {
    const d: Vec3 = [0.3, -0.4, 0.8];
    const n = length3(d);
    const lightView = Matrix.lookAt(new Float64Array(16), [d[0] / n, d[1] / n, d[2] / n], [0, 0, 0], [0, 0, 1]);
    const footprint: Vec2[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    const plane = must(R.cascadeExtremes(footprint, 2, [0, 0], lightView));
    const relief = must(R.cascadeExtremes(footprint, 2, [-3, 5], lightView));
    expect(relief.minDepth).toBeLessThan(plane.minDepth);
    expect(relief.maxDepth).toBeGreaterThan(plane.maxDepth);
  });

  test("the window follows where the camera looks", () => {
    const reference = must(resolve({ eye: makeEye((55 * Math.PI) / 180, 0, 0.8) }));
    const turned = must(resolve({ eye: makeEye((55 * Math.PI) / 180, Math.PI, 0.8) }));
    let moved = false;
    for (let i = 0; i < 16; i++) if (Math.abs(reference.shadowUniform.near.worldToShadowTexture[i]! - turned.shadowUniform.near.worldToShadowTexture[i]!) > 1e-4) moved = true;
    expect(moved).toBe(true);
    const steep = must(resolve({ eye: makeEye((5 * Math.PI) / 180, 0, 0.8) }));
    expect(reference.shadowUniform.near.normalOffsetWorld).toBeGreaterThan(steep.shadowUniform.near.normalOffsetWorld);
  });

  test("the texel grid stays glued to the content across a pan", () => {
    const eye = makeEye((40 * Math.PI) / 180, 0.7, 0.8);
    const half = renderMapSize * 0.5;
    const pan1: Vec2 = [0.312, -0.144];
    const pan2: Vec2 = [pan1[0] + 3.7e-7, pan1[1] - 2.2e-7];
    const state1 = must(resolve({ eye, flatRenderPan: pan1 }));
    const state2 = must(resolve({ eye, flatRenderPan: pan2 }));
    const shift: Vec2 = [(pan2[0] - pan1[0]) * half, -(pan2[1] - pan1[1]) * half];
    const texels = state1.mapResolution;
    for (const w1 of [[0.05, -0.1, 0], [-0.12, 0.07, 0.001], [0, 0, 0]] as Vec3[]) {
      const w2: Vec3 = [w1[0] + shift[0], w1[1] + shift[1], w1[2]];
      const uv1 = project(state1.shadowUniform.near.worldToShadowTexture, w1);
      const uv2 = project(state2.shadowUniform.near.worldToShadowTexture, w2);
      const dx = (uv1[0] - uv2[0]) * texels;
      const dy = (uv1[1] - uv2[1]) * texels;
      expect(Math.abs(dx - Math.round(dx))).toBeLessThan(0.05);
      expect(Math.abs(dy - Math.round(dy))).toBeLessThan(0.05);
    }
  });

  test("the receiver bias scales with the texel size", () => {
    const coarse = must(resolve({ scene: withShadows({ mapResolution: 1024 }) })).shadowUniform.near;
    const fine = must(resolve({ scene: withShadows({ mapResolution: 4096 }) })).shadowUniform.near;
    expect(coarse.depthBias).toBeGreaterThan(0);
    expect(fine.depthBias).toBeGreaterThan(0);
    expect(Math.abs(coarse.depthBias / fine.depthBias - 4)).toBeLessThan(0.2);
    expect(coarse.depthBias).toBeLessThan(0.01);
  });

  test("the normal offset is exactly the texel multiple at every zoom", () => {
    const scene = withShadows({ mapResolution: 2048 });
    const requested = scene.shadows.normalOffsetTexels;
    for (const distance of [0.05, 0.3, 0.8, 2.0]) {
      const state = must(resolve({ eye: makeEye((30 * Math.PI) / 180, 0.4, distance), scene }));
      const cascade = state.shadowUniform.near;
      expect(cascade.normalOffsetWorld).toBeGreaterThan(0);
      expect(cascade.texelSizeUV[0]).toBeCloseTo(1 / 2048, 9);
      expect(cascade.texelSizeUV[1]).toBeCloseTo(1 / 2048, 9);
      const inDistances = cascade.normalOffsetWorld / distance;
      expect(inDistances).toBeGreaterThan(0.0005);
      expect(inDistances).toBeLessThan(0.05);
      expect(state.mapResolution).toBe(2048);
      expect(cascade.normalOffsetWorld / requested).toBeGreaterThan(0);
    }
  });

  test("the normal offset follows the setting", () => {
    const narrow = must(resolve({ scene: withShadows({ normalOffsetTexels: 1 }) }));
    const wide = must(resolve({ scene: withShadows({ normalOffsetTexels: 4 }) }));
    expect(wide.shadowUniform.near.normalOffsetWorld / narrow.shadowUniform.near.normalOffsetWorld).toBeCloseTo(4, 4);
  });

  test("the normal offset is clamped to the settable range", () => {
    expect(must(resolve({ scene: withShadows({ normalOffsetTexels: 0 }) })).shadowUniform.near.normalOffsetWorld).toBe(0);
    const clamped = must(resolve({ scene: withShadows({ normalOffsetTexels: 1000 }) }));
    const atMaximum = must(resolve({ scene: withShadows({ normalOffsetTexels: R.normalOffsetTexelsRange[1] }) }));
    expect(clamped.shadowUniform.near.normalOffsetWorld).toBe(atMaximum.shadowUniform.near.normalOffsetWorld);
    expect(must(resolve({ scene: withShadows({ normalOffsetTexels: -5 }) })).shadowUniform.near.normalOffsetWorld).toBe(0);
  });

  test("the softness reaches the shader and is clamped", () => {
    expect(must(resolve({ scene: withShadows({ softness: 1 }) })).shadowUniform.near.tentSpread).toBe(1);
    expect(must(resolve({ scene: withShadows({ softness: 1.8 }) })).shadowUniform.near.tentSpread).toBeCloseTo(1.8, 6);
    expect(must(resolve({ scene: withShadows({ softness: 100 }) })).shadowUniform.near.tentSpread).toBe(R.softnessRange[1]);
    expect(must(resolve({ scene: withShadows({ softness: -1 }) })).shadowUniform.near.tentSpread).toBe(R.softnessRange[0]);
  });

  test("the softness changes nothing but the kernel", () => {
    const plain = must(resolve({ scene: withShadows({ softness: 1 }) }));
    const softest = must(resolve({ scene: withShadows({ softness: R.softnessRange[1] }) }));
    expect(plain.shadowUniform.near.texelSizeUV).toEqual(softest.shadowUniform.near.texelSizeUV);
    expect(plain.shadowUniform.near.depthBias).toBe(softest.shadowUniform.near.depthBias);
    expect(plain.shadowUniform.near.uvMinimum).toEqual(softest.shadowUniform.near.uvMinimum);
    expect(plain.shadowUniform.near.uvMaximum).toEqual(softest.shadowUniform.near.uvMaximum);
    expect(plain.shadowUniform.near.normalOffsetWorld).toBe(softest.shadowUniform.near.normalOffsetWorld);
    expect(plain.lightProjectionView).toEqual(softest.lightProjectionView);
  });

  test("the sampling inset covers the widest kernel", () => {
    expect(R.uvInsetTexels).toBeGreaterThanOrEqual(R.softnessRange[1] + 0.5);
  });

  test("a small coverage shrinks the window and keeps the shadows", () => {
    const eye = makeEye((40 * Math.PI) / 180, 0.4, 0.8);
    const wide = must(resolve({ eye, scene: withShadows({ nearCoverageMeters: coverage(3, eye) }) }));
    const tight = must(resolve({ eye, scene: withShadows({ nearCoverageMeters: coverage(0.25, eye) }) }));
    expect(tight.shadowUniform.near.normalOffsetWorld).toBeLessThan(wide.shadowUniform.near.normalOffsetWorld);
    expect(tight.shadowUniform.near.fadeStartDistance).toBeGreaterThan(0);
    expect(tight.shadowUniform.near.fadeStartDistance).toBeLessThan(tight.shadowUniform.near.fadeEndDistance);
  });

  test("the fade band is always the outer quarter of the window", () => {
    for (const radius of [2.4, 0.8, 0.2, 0.05]) {
      const fade = R.fadeDistances(radius);
      expect(fade.end).toBe(radius);
      expect(fade.start).toBeCloseTo(radius * 0.75, 6);
    }
  });

  test("the coverage is clamped to its range", () => {
    const floored = must(resolve({ scene: withShadows({ nearCoverageMeters: zoomCurve(0) }) }));
    const atFloor = must(resolve({ scene: withShadows({ nearCoverageMeters: zoomCurve(R.coverageMetersRange[0]) }) }));
    expect(floored.shadowUniform.near.worldToShadowTexture).toEqual(atFloor.shadowUniform.near.worldToShadowTexture);
    const ceilinged = must(resolve({ scene: withShadows({ nearCoverageMeters: zoomCurve(1e9) }) }));
    const atCeiling = must(resolve({ scene: withShadows({ nearCoverageMeters: zoomCurve(R.coverageMetersRange[1]) }) }));
    expect(ceilinged.shadowUniform.near.worldToShadowTexture).toEqual(atCeiling.shadowUniform.near.worldToShadowTexture);
  });

  test("the ground under the camera is shadowed at every coverage", () => {
    const eye = makeEye((40 * Math.PI) / 180, 0.4, 0.8);
    for (const c of [3, 1, 0.5, 0.25]) {
      const uniform = must(resolve({ eye, scene: withShadows({ nearCoverageMeters: coverage(c, eye) }) })).shadowUniform;
      const fadeAt = (radial: number) => 1 - smoothstep(uniform.near.fadeStartDistance, uniform.near.fadeEndDistance, radial);
      expect(fadeAt(0)).toBeCloseTo(1, 5);
      expect(fadeAt(uniform.near.fadeEndDistance / 3)).toBeCloseTo(1, 5);
      expect(fadeAt(uniform.near.fadeEndDistance)).toBeCloseTo(0, 5);
    }
  });

  test("the coverage shrinks the texel at a street camera", () => {
    const eye = makeEye((55 * Math.PI) / 180, 0.3, 0.05);
    const texel = (c: number) => {
      const scene = withShadows({ nearCoverageMeters: coverage(c, eye) });
      return must(resolve({ eye, scene })).shadowUniform.near.normalOffsetWorld / scene.shadows.normalOffsetTexels;
    };
    const wide = texel(3);
    expect(wide / texel(0.25)).toBeGreaterThan(2.5);
    let previous = wide;
    for (const c of [2, 1, 0.5, 0.25]) {
      const current = texel(c);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  test("the caster limit follows the setting and the window", () => {
    const spec = (distance: number, c: number, heightMeters: number) => R.windowSpec((c * distance) / unitsPerMeter, unitsPerMeter, heightMeters);
    for (const heightMeters of [20, 50, 120]) {
      expect(Math.abs(spec(0.05, 3, heightMeters).maxCasterHeight - heightMeters * unitsPerMeter)).toBeLessThanOrEqual(unitsPerMeter);
    }
    expect(spec(0.8, 3, 10_000).maxCasterHeight).toBe(spec(0.8, 3, R.maxCasterHeightRange[1]).maxCasterHeight);
    expect(spec(0.8, 3, 0).maxCasterHeight).toBe(spec(0.8, 3, R.maxCasterHeightRange[0]).maxCasterHeight);
    const tight = spec(0.05, 0.25, 500);
    expect(tight.maxCasterHeight).toBeCloseTo(R.maxCasterHeightWindowRadii * tight.radius, 6);
  });

  test("a lower caster limit shrinks the texel", () => {
    const eye = makeEye((55 * Math.PI) / 180, 0.3, 0.05);
    const texel = (heightMeters: number) => {
      const scene = withShadows({ maxCasterHeightMeters: heightMeters });
      return must(resolve({ eye, scene })).shadowUniform.near.normalOffsetWorld / scene.shadows.normalOffsetTexels;
    };
    expect(texel(500) / texel(50)).toBeGreaterThan(1.9);
  });

  test("a coverage beyond the visible ground costs nothing", () => {
    const eye = makeEye((15 * Math.PI) / 180, 0.2, 0.05);
    const texel = (c: number) => {
      const scene = withShadows({ nearCoverageMeters: coverage(c, eye) });
      return must(resolve({ eye, scene })).shadowUniform.near.normalOffsetWorld / scene.shadows.normalOffsetTexels;
    };
    expect(texel(12)).toBeCloseTo(texel(3), 9);
  });

  test("the geometric cutoff band mirrors the shader", () => {
    expect(R.geometricCutoffStart).toBeLessThan(R.geometricCutoffEnd);
    expect(R.geometricCutoffStart).toBeGreaterThan(0);
    expect(R.geometricCutoffEnd).toBeLessThan(1);
  });

  test("the window is the coverage in metres", () => {
    const radius = (meters: number) => R.windowSpec(meters, unitsPerMeter, 10).radius;
    const threeHundred = 300 * unitsPerMeter;
    expect(Math.abs(radius(300) - threeHundred)).toBeLessThanOrEqual(threeHundred * 1e-5);
    expect(radius(0)).toBe(radius(R.coverageMetersRange[0]));
    expect(radius(Infinity)).toBe(radius(R.coverageMetersRange[0]));
    expect(radius(1e12)).toBe(radius(R.coverageMetersRange[1]));
  });
});

describe("the shadows' zoom", () => {
  test("the shadows come in with the zoom", () => {
    const scene = withShadows({ strength: zoomCurve({ 12: 0, 13: 0.22 }) });
    const shadows = scene.shadows;
    expect(shadowStrength(shadows, 10)).toBe(0);
    expect(shadowStrength(shadows, 12)).toBe(0);
    expect(shadowStrength(shadows, 12.5)).toBeCloseTo(0.11, 6);
    expect(shadowStrength(shadows, 13)).toBeCloseTo(0.22, 6);
    expect(shadowStrength(shadows, 16)).toBeCloseTo(0.22, 6);
    expect(shadowStrength({ ...shadows, strength: zoomCurve(3) }, 16)).toBe(1);
    const eye: Vec3 = [0.2, -0.35, 0.7];
    const input = (z: number) => ({
      renderSurfaceMode: "flat" as const,
      projectionView: makeProjectionView(eye),
      cameraEye: eye,
      centerWorldMercator: equatorCenter,
      flatRenderPan: [0, 0] as Vec2,
      renderMapSize,
      zoom: z,
      scene,
    });
    expect(R.resolveInputs(input(10))).toBeUndefined();
    expect(must(R.resolveInputs(input(12.5))).strength).toBeCloseTo(0.11, 6);
  });
});

describe("the far window", () => {
  test("the far window reaches past the near one", () => {
    const eye = makeEye((40 * Math.PI) / 180, 0.4, 0.8);
    const scene = withShadows({ nearCoverageMeters: coverage(1, eye), farCoverageMeters: coverage(4, eye) });
    const state = must(resolve({ eye, scene }));
    const { near, far } = state.shadowUniform;
    expect(ShadowCascadeUniform.isEnabled(far)).toBe(true);
    expect(state.farLightProjectionView).toBeDefined();
    expect(ShadowFrameState.slots(state)).toEqual(["near", "far"]);
    expect(Math.abs(far.fadeEndDistance - radiusOf(scene.shadows.farCoverageMeters))).toBeLessThanOrEqual(far.fadeEndDistance * 1e-5);
    expect(Math.abs(near.fadeEndDistance - radiusOf(scene.shadows.nearCoverageMeters))).toBeLessThanOrEqual(near.fadeEndDistance * 1e-5);
    expect(far.fadeStartDistance).toBeGreaterThanOrEqual(near.fadeEndDistance);
    expect(far.normalOffsetWorld).toBeGreaterThan(near.normalOffsetWorld);
    expect(far.texelSizeUV).toEqual(near.texelSizeUV);
    expect(ShadowFrameState.casterCullingProjectionView(state)).toBe(state.farLightProjectionView);
  });

  test("the far window holds the near one", () => {
    const eye = makeEye((50 * Math.PI) / 180, 1.1, 0.6);
    const state = must(resolve({ eye }));
    const farMatrix = must(state.farLightProjectionView);
    const shadows = defaultScene.shadows;
    const near = R.windowSpec(shadowNearCoverageMeters(shadows, zoom), unitsPerMeter, shadows.maxCasterHeightMeters);
    for (const point of R.visibleGroundFootprint(inverseOf(makeProjectionView(eye)), eye, near.radius)) {
      for (const z of [0, near.maxCasterHeight]) {
        const ndc = project(farMatrix, [point[0], point[1], z]);
        expect(Math.abs(ndc[0])).toBeLessThanOrEqual(1 + 1e-3);
        expect(Math.abs(ndc[1])).toBeLessThanOrEqual(1 + 1e-3);
        expect(ndc[2]).toBeGreaterThanOrEqual(-1e-3);
        expect(ndc[2]).toBeLessThanOrEqual(1 + 1e-3);
      }
    }
  });

  test("a far coverage under the near one leaves one window", () => {
    const state = must(resolve({ scene: withShadows({ nearCoverageMeters: zoomCurve(3000), farCoverageMeters: zoomCurve(3500) }) }));
    expect(ShadowCascadeUniform.isEnabled(state.shadowUniform.far)).toBe(false);
    expect(state.farLightProjectionView).toBeUndefined();
    expect(ShadowFrameState.slots(state)).toEqual(["near"]);
    expect(ShadowFrameState.casterCullingProjectionView(state)).toBe(state.lightProjectionView);
    const both = must(resolve({ scene: withShadows({ nearCoverageMeters: zoomCurve(3000), farCoverageMeters: zoomCurve(4000) }) }));
    expect(ShadowCascadeUniform.isEnabled(both.shadowUniform.far)).toBe(true);
    expect(R.farWindowReaches(4, 3)).toBe(true);
    expect(R.farWindowReaches(3.9, 3)).toBe(false);
  });

  test("the coverages follow the zoom", () => {
    const scene = withShadows({
      strength: zoomCurve(0.22),
      nearCoverageMeters: zoomCurve({ 14: 6000, 18: 500 }),
      farCoverageMeters: zoomCurve({ 14: 24_000, 18: 600 }),
    });
    const overview = must(resolve({ scene, zoom: 14 }));
    const street = must(resolve({ scene, zoom: 18 }));
    expect(Math.abs(overview.shadowUniform.near.fadeEndDistance - 6000 * unitsPerMeter)).toBeLessThanOrEqual(6 * unitsPerMeter);
    expect(Math.abs(street.shadowUniform.near.fadeEndDistance - 500 * unitsPerMeter)).toBeLessThanOrEqual(0.5 * unitsPerMeter);
    expect(ShadowCascadeUniform.isEnabled(overview.shadowUniform.far)).toBe(true);
    expect(ShadowCascadeUniform.isEnabled(street.shadowUniform.far)).toBe(false);
    const between = must(resolve({ scene, zoom: 16 }));
    expect(Math.abs(between.shadowUniform.near.fadeEndDistance - Math.sqrt(6000 * 500) * unitsPerMeter)).toBeLessThanOrEqual(2 * unitsPerMeter);
  });

  test("the slice rectangles and the fade follow the coverage", () => {
    const eye = makeEye((30 * Math.PI) / 180, 0.4, 0.8);
    const state = must(resolve({ eye }));
    const cascade = state.shadowUniform.near;
    expect(cascade.uvMinimum[0]).toBeGreaterThan(0);
    expect(cascade.uvMaximum[0]).toBeLessThan(1);
    expect(cascade.uvMinimum[0]).toBe(cascade.uvMinimum[1]);
    expect(cascade.uvMaximum[0]).toBe(cascade.uvMaximum[1]);
    const expected = radiusOf(defaultScene.shadows.nearCoverageMeters);
    expect(Math.abs(cascade.fadeEndDistance - expected)).toBeLessThanOrEqual(expected * 1e-5);
    expect(Math.abs(cascade.fadeStartDistance - expected * 0.75)).toBeLessThanOrEqual(expected * 1e-5);
    expect(state.shadowUniform.eye).toEqual(eye);
    const light = state.shadowUniform.lightDirection;
    expect(length3(light)).toBeCloseTo(1, 6);
    const d = defaultScene.light.direction;
    const n = length3(d);
    expect(Math.hypot(light[0] - d[0] / n, light[1] - d[1] / n, light[2] - d[2] / n)).toBeCloseTo(0, 6);
  });
});
