// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `HorizonFrameResolverTests`, `HorizonUniformLayoutTests`
// and `HorizonBandMathTests`.

import { describe, expect, test } from "vitest";
import type { ViewMode } from "../camera/view-mode.ts";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { zoomCurveValue } from "../configuration/zoom-curve.ts";
import { Matrix, mat4Multiply } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";
import { defaultTheme, themeBaseColors } from "../style/theme.ts";
import { HorizonBandMath, type HorizonHaze, HorizonFrameResolver } from "./horizon-frame-resolver.ts";
import { HorizonUniformLayout, writeHorizonUniform } from "./horizon-uniform.ts";
import horizonSource from "./shaders/horizon.wgsl?raw";

const R = HorizonFrameResolver;
const mapColor = themeBaseColors(defaultTheme).map;
const defaults = ImmersiveMapSettings.default;

interface ResolveOptions {
  transition: number;
  geometryTransition: number;
  mode: ViewMode;
  radius?: number;
  pitch?: number;
  heightPx?: number;
  zoom?: number;
}

/** The render camera of the Swift offscreen harness: unit distance from the view centre, pitched about x, a square viewport. */
function resolve(settings: ImmersiveMapSettings, o: ResolveOptions): HorizonHaze {
  const pitch = o.pitch ?? 0;
  const eye: Vec3 = [0, -Math.sin(pitch), Math.cos(pitch)];
  const up: Vec3 = [0, Math.cos(pitch), Math.sin(pitch)];
  const projection = Matrix.perspectiveMatrix(new Float64Array(16), Math.PI / 4, 1, 0.01, 200);
  const view = Matrix.lookAt(new Float64Array(16), eye, [0, 0, 0], up);
  return R.resolve({
    settings,
    mapColor,
    transition: o.transition,
    zoom: o.zoom ?? 8,
    globe: { panX: 0, panY: 0, radius: o.radius ?? 0.28, transition: o.geometryTransition },
    renderSurfaceMode: o.mode,
    cameraEye: eye,
    projectionView: mat4Multiply(new Float64Array(16), projection, view),
    verticalFovRadians: Math.PI / 4,
    drawableHeightPx: o.heightPx ?? 200,
  });
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function expectVecClose(a: Vec3, b: Vec3, tolerance = 1e-9): void {
  expect(distance(a, b)).toBeLessThan(tolerance);
}

function expectGroundSideEqual(a: HorizonHaze, b: HorizonHaze): void {
  expect(a.groundGain).toBeCloseTo(b.groundGain, 5);
  expect(a.groundBandRadians).toBeCloseTo(b.groundBandRadians, 5);
  expect(a.cutoffStartRadians).toBeCloseTo(b.cutoffStartRadians, 5);
  expect(a.cutoffEndRadians).toBeCloseTo(b.cutoffEndRadians, 5);
  expectVecClose(a.tint, b.tint, 1e-5);
  expect(a.edge.depression).toBeCloseTo(b.edge.depression, 5);
  expectVecClose(a.edge.up, b.edge.up, 1e-5);
}

const resting: ResolveOptions = { transition: 0, geometryTransition: 0, mode: "spherical" };
const plane: ResolveOptions = { transition: 1, geometryTransition: 1, mode: "flat", pitch: 1.25 };

describe("HorizonFrameResolver: the resting globe", () => {
  test("wears the atmosphere", () => {
    const haze = resolve(defaults, resting);
    const atmosphere = defaults.scene.atmosphere;
    expect(atmosphere.isEnabled).toBe(true);
    expect(haze.skyStrength).toBe(atmosphere.intensity);
    expect(haze.tint).toEqual(atmosphere.color);
    expect(haze.whitenWeight).toBe(R.haloWhitenWeight);
    expect(haze.sunInfluence).toBeCloseTo(atmosphere.sunInfluence, 6);
    expect(haze.groundGain).toBe(atmosphere.intensity);
    expect(haze.featherStrength).toBe(R.featherPeakStrength);
    expect(haze.drawsSky).toBe(true);
    expect(haze.drawsGround).toBe(true);
    expect(haze.bandTopRadians).toBeCloseTo(haze.glowRadians * R.bandTopGlowWidths, 6);

    const radius = 0.28;
    const centerDistance = 1 + radius;
    const limbDistance = Math.sqrt(centerDistance * centerDistance - radius * radius);
    const shell = (radius * zoomCurveValue(atmosphere.thickness, 8)) / limbDistance;
    expect(haze.bandRadians).toBeCloseTo(R.haloBandRadii * shell, 5);
    expect(haze.glowRadians).toBeCloseTo(R.haloGlowRadii * shell, 5);
    expect(haze.groundBandRadians).toBeCloseTo(R.haloRimRadii * shell, 5);
    expect(haze.cutoffStartRadians).toBeCloseTo(haze.groundBandRadians * R.rimCutoffStartWidths, 5);
    expect(haze.cutoffEndRadians).toBeCloseTo(haze.groundBandRadians * R.rimCutoffEndWidths, 5);
  });

  test("the thickness stretches the halo", () => {
    const thick = resolve(defaults.atmosphereSettings({ thickness: 2 }), resting);
    const shipped = resolve(defaults, resting);
    const ratio = 2 / zoomCurveValue(defaults.scene.atmosphere.thickness, 8);
    expect(thick.bandRadians).toBeCloseTo(shipped.bandRadians * ratio, 5);
    expect(thick.glowRadians).toBeCloseTo(shipped.glowRadians * ratio, 5);
  });

  test("the atmosphere off keeps only the feather", () => {
    const haze = resolve(defaults.atmosphere({ isEnabled: false }), resting);
    expect(haze.skyStrength).toBe(0);
    expect(haze.groundGain).toBe(0);
    expect(haze.whitenWeight).toBe(0);
    expect(haze.sunInfluence).toBe(0);
    expect(haze.tint).toEqual([mapColor[0], mapColor[1], mapColor[2]]);
    expect(haze.featherStrength).toBe(R.featherPeakStrength);
    expect(haze.drawsSky).toBe(true);
    expect(haze.drawsGround).toBe(true);
  });

  test("the feather is a fixed number of pixels", () => {
    const small = resolve(defaults, { ...resting, heightPx: 200 });
    const large = resolve(defaults, { ...resting, heightPx: 2000 });
    expect(small.featherRadians).toBeCloseTo((R.featherPixels * (Math.PI / 4)) / 200, 7);
    expect(large.featherRadians).toBeCloseTo(small.featherRadians / 10, 7);
  });

  test("transparent space skips the sky side", () => {
    const haze = resolve(defaults.transparentSpace(), resting);
    expect(haze.drawsSky).toBe(false);
    expect(haze.drawsGround).toBe(true);
  });
});

describe("HorizonFrameResolver: the plane", () => {
  test("wears the sky and nothing on the ground", () => {
    const fog = defaults.scene.fog;
    expect(fog.isEnabled).toBe(true);
    const haze = resolve(defaults, plane);
    expect(haze.edge.depression).toBe(0);
    expectVecClose(haze.edge.up, [0, 0, 1]);
    expect(haze.skyStrength).toBe(0);
    expect(haze.featherStrength).toBe(0);
    expect(haze.whitenWeight).toBe(0);
    expect(haze.sunInfluence).toBe(0);
    expectVecClose(haze.tint, fog.horizonColor);
    expect(haze.skyColor).toEqual(fog.skyColor);
    expect(haze.skyOpacity).toBe(1);
    expect(haze.skyGradientRadians).toBe(R.skyGradientRadians);
    expect(haze.groundGain).toBe(0);
    expect(haze.drawsSky).toBe(true);
    expect(haze.drawsGround).toBe(false);
    expect(haze.bandTopRadians).toBeGreaterThan(R.bandTopMarginRadians);
  });

  test("the fog off paints nothing on the plane", () => {
    const haze = resolve(defaults.fog({ isEnabled: false }), plane);
    expect(haze.skyOpacity).toBe(0);
    expect(haze.groundGain).toBe(0);
    expect(haze.drawsSky).toBe(false);
    expect(haze.drawsGround).toBe(false);
  });

  test("the plane ignores the atmosphere switch", () => {
    const on = resolve(defaults, plane);
    const off = resolve(defaults.atmosphere({ isEnabled: false }), plane);
    expectVecClose(on.tint, off.tint);
    expect({ ...on, tint: off.tint }).toEqual(off);
  });

  test("transparent space keeps the plane's sky", () => {
    expect(resolve(defaults.transparentSpace(), plane).drawsSky).toBe(true);
  });

  test("a low pitch skips both draws", () => {
    const haze = resolve(defaults, { ...plane, pitch: 0.3 });
    expect(haze.drawsSky).toBe(false);
    expect(haze.drawsGround).toBe(false);
  });
});

describe("HorizonFrameResolver: the morph", () => {
  test("the atmosphere rides the unroll", () => {
    const start = defaults.presentation.airHandoverStart;
    const rest = resolve(defaults, { ...resting, pitch: 1.25 });
    let previousBand = rest.bandRadians;
    for (const transition of [0.2, 0.5, start]) {
      const haze = resolve(defaults, { transition, geometryTransition: transition / 0.9, mode: "spherical", pitch: 1.25 });
      expect(haze.skyStrength).toBe(rest.skyStrength);
      expect(haze.featherStrength).toBe(rest.featherStrength);
      expect(haze.groundGain).toBe(rest.groundGain);
      expect(haze.sunInfluence).toBe(rest.sunInfluence);
      expect(haze.whitenWeight).toBe(rest.whitenWeight);
      expect(haze.tint).toEqual(rest.tint);
      expect(haze.skyOpacity).toBe(0);
      expect(haze.drawsSky).toBe(true);
      expect(haze.drawsGround).toBe(true);
      expect(haze.bandRadians).toBeLessThan(previousBand);
      previousBand = haze.bandRadians;
    }
  });

  test("the air hands over at the end of the morph", () => {
    const { presentation, scene } = defaults;
    const atmosphere = scene.atmosphere;
    const fog = scene.fog;
    const midway = (presentation.airHandoverStart + presentation.airHandoverEnd) / 2;
    const options: ResolveOptions = { transition: midway, geometryTransition: midway / 0.9, mode: "spherical", pitch: 1.25 };
    const haze = resolve(defaults, options);
    expect(haze.skyStrength).toBeCloseTo(atmosphere.intensity / 2, 5);
    expect(haze.groundGain).toBeCloseTo(atmosphere.intensity / 2, 5);
    expect(haze.featherStrength).toBeCloseTo(R.featherPeakStrength / 2, 5);
    expect(haze.sunInfluence).toBeCloseTo(atmosphere.sunInfluence / 2, 5);
    expect(haze.whitenWeight).toBeCloseTo(R.haloWhitenWeight / 2, 5);
    expect(haze.skyOpacity).toBeCloseTo(0.5, 5);
    const halfway: Vec3 = [(atmosphere.color[0] + fog.horizonColor[0]) / 2, (atmosphere.color[1] + fog.horizonColor[1]) / 2, (atmosphere.color[2] + fog.horizonColor[2]) / 2];
    expectVecClose(haze.tint, halfway, 1e-5);
    expect(haze.skyColor).toEqual(fog.skyColor);
    expect(haze.drawsSky).toBe(true);
    expect(haze.drawsGround).toBe(true);
    expect(haze.bandTopRadians).toBeGreaterThan(R.bandTopMarginRadians);

    const transparent = resolve(defaults.transparentSpace(), options);
    expect(transparent.skyStrength).toBe(0);
    expect(transparent.sunInfluence).toBe(0);
    expect(transparent.skyOpacity).toBeCloseTo(0.5, 5);
    expect(transparent.featherStrength).toBe(haze.featherStrength);
    expect(transparent.drawsSky).toBe(true);
  });

  test("the handed-over air is the plane's", () => {
    const end = defaults.presentation.airHandoverEnd;
    const fog = defaults.scene.fog;
    const handedOver = resolve(defaults, { transition: end, geometryTransition: 1, mode: "spherical", pitch: 1.25 });
    expect(handedOver.skyStrength).toBe(0);
    expect(handedOver.featherStrength).toBe(0);
    expect(handedOver.groundGain).toBe(0);
    expect(handedOver.skyOpacity).toBe(1);
    expectVecClose(handedOver.tint, fog.horizonColor);
    expect(handedOver.drawsSky).toBe(true);
    expect(handedOver.drawsGround).toBe(false);

    const finished = resolve(defaults, { transition: 1, geometryTransition: 1, mode: "spherical", pitch: 1.25 });
    const switched = resolve(defaults, plane);
    expect(handedOver).toEqual(finished);
    expectGroundSideEqual(finished, switched);
    expect(finished.skyOpacity).toBe(switched.skyOpacity);
    expect(finished.drawsSky).toBe(switched.drawsSky);
    expect(finished.bandTopRadians).toBeCloseTo(switched.bandTopRadians, 5);

    const bare = defaults.fog({ isEnabled: false });
    const bareFinished = resolve(bare, { transition: 1, geometryTransition: 1, mode: "spherical", pitch: 1.25 });
    const bareSwitched = resolve(bare, plane);
    expectGroundSideEqual(bareFinished, bareSwitched);
    expect(bareFinished.groundGain).toBe(0);
    expect(bareFinished.drawsSky).toBe(false);
    expect(bareFinished.drawsGround).toBe(false);
  });

  test("the handover follows the settings", () => {
    const settings = defaults.globe({ airHandoverStart: 0.3, airHandoverEnd: 0.5 });
    const at = (transition: number) => resolve(settings, { transition, geometryTransition: transition / 0.9, mode: "spherical", pitch: 1.25 });
    expect(at(0.3).skyOpacity).toBe(0);
    expect(at(0.4).skyOpacity).toBeCloseTo(0.5, 5);
    expect(at(0.5).skyOpacity).toBe(1);
    expect(at(0.5).skyStrength).toBe(0);
  });

  test("the fades are continuous", () => {
    let previous = resolve(defaults, { ...resting, pitch: 1.25 });
    for (let step = 1; step <= 1000; step++) {
      const transition = step / 1000;
      const haze = resolve(defaults, { transition, geometryTransition: Math.min(1, transition / 0.9), mode: "spherical", pitch: 1.25 });
      expect(Math.abs(haze.skyStrength - previous.skyStrength)).toBeLessThan(0.05);
      expect(Math.abs(haze.groundGain - previous.groundGain)).toBeLessThan(0.05);
      expect(Math.abs(haze.featherStrength - previous.featherStrength)).toBeLessThan(0.05);
      expect(Math.abs(haze.skyOpacity - previous.skyOpacity)).toBeLessThan(0.05);
      expect(distance(haze.tint, previous.tint)).toBeLessThan(0.05);
      previous = haze;
    }
  });
});

describe("HorizonFrameResolver: the ground profile", () => {
  test("is the rim's, and the plane has none", () => {
    const globe = resolve(defaults, resting);
    expect(R.groundProfile(0, globe)).toBeGreaterThan(0);
    expect(R.groundProfile(globe.cutoffEndRadians, globe)).toBe(0);
    let previous = R.groundProfile(0, globe);
    for (let step = 1; step <= 60; step++) {
      const amount = R.groundProfile((globe.cutoffEndRadians * step) / 60, globe);
      expect(amount).toBeLessThanOrEqual(previous + 1e-6);
      previous = amount;
    }
    const flat = resolve(defaults, plane);
    for (let step = 0; step <= 10; step++) expect(R.groundProfile(step * 0.01, flat)).toBe(0);
  });
});

describe("HorizonUniformLayout", () => {
  test("mirrors the shader struct's member order and WGSL's natural offsets", () => {
    const struct = /struct Horizon \{([\s\S]*?)\n\}/.exec(horizonSource)?.[1] ?? "";
    const members = [...struct.matchAll(/^\s*(\w+): (\w+),/gm)].map((m) => [m[1]!, m[2]!] as const);
    const sizes: Record<string, [size: number, align: number]> = { f32: [4, 4], vec3f: [12, 16], mat4x4f: [64, 16] };
    let offset = 0;
    const layout = HorizonUniformLayout as Record<string, number>;
    for (const [name, type] of members) {
      const [size, align] = sizes[type]!;
      offset = Math.ceil(offset / align) * align;
      expect(layout[name], name).toBe(offset);
      offset += size;
    }
    expect(members.length).toBe(Object.keys(HorizonUniformLayout).length - 1);
    expect(HorizonUniformLayout.byteLength).toBe(Math.ceil(offset / 16) * 16);
  });

  test("writes every value where the layout says", () => {
    const haze = resolve(defaults, resting);
    const target = new Float32Array(HorizonUniformLayout.byteLength / 4);
    const matrix = Float64Array.from({ length: 16 }, (_, i) => i + 1);
    writeHorizonUniform(target, haze, matrix, [0.5, 0.25, 2]);
    expect(target[HorizonUniformLayout.depression / 4]).toBeCloseTo(haze.edge.depression, 6);
    expect(target[HorizonUniformLayout.eye / 4 + 2]).toBe(2);
    expect(target[HorizonUniformLayout.bandTopRadians / 4]).toBeCloseTo(haze.bandTopRadians, 6);
    expect(target[HorizonUniformLayout.viewProjection / 4 + 15]).toBe(16);
  });
});

describe("HorizonBandMath", () => {
  const restingHaze = (heightPx = 2000, radius = 0.28): HorizonHaze => {
    const eye: Vec3 = [0, 0, 1];
    const projection = Matrix.perspectiveMatrix(new Float64Array(16), Math.PI / 4, 1, 0.01, 200);
    const view = Matrix.lookAt(new Float64Array(16), eye, [0, 0, 0], [0, 1, 0]);
    return R.resolve({
      settings: defaults,
      mapColor,
      transition: 0,
      zoom: 2,
      globe: { panX: 0, panY: 0, radius, transition: 0 },
      renderSurfaceMode: "spherical",
      cameraEye: eye,
      projectionView: mat4Multiply(new Float64Array(16), projection, view),
      verticalFovRadians: Math.PI / 4,
      drawableHeightPx: heightPx,
    });
  };

  test("the stations run from the rim's end to the band's top", () => {
    const haze = restingHaze();
    const angles = HorizonBandMath.stationAngles(haze);
    expect(angles.length).toBe(HorizonBandMath.stationCount);
    expect(angles[0]).toBe(-haze.cutoffEndRadians);
    expect(angles[angles.length - 1]).toBe(haze.bandTopRadians);
    expect(angles).toContain(0);
    expect(angles[4]).toBeGreaterThanOrEqual(haze.featherRadians * 4);
  });

  test("the stations stay on the sphere of directions", () => {
    const low = restingHaze(2000, 200);
    expect(low.glowRadians).toBeCloseTo(R.maximumHaloRadians, 6);
    const angles = HorizonBandMath.stationAngles(low);
    expect(angles[angles.length - 1]!).toBeLessThan(low.edge.depression + Math.PI / 2);
    expect(angles[0]!).toBeGreaterThan(low.edge.depression - Math.PI / 2);
    for (let i = 1; i < angles.length; i++) expect(angles[i - 1]!).toBeLessThanOrEqual(angles[i]!);
  });

  test("the stations stay in order on a small drawable", () => {
    for (const heightPx of [100, 200, 2000]) {
      const angles = HorizonBandMath.stationAngles(restingHaze(heightPx));
      for (let i = 1; i < angles.length; i++) expect(angles[i - 1]!).toBeLessThanOrEqual(angles[i]!);
    }
  });

  test("the mesh is a closed ring of quads, azimuth by station", () => {
    const { vertices, indices } = HorizonBandMath.mesh();
    expect(vertices.length).toBe(HorizonBandMath.segmentCount * HorizonBandMath.stationCount * 2);
    expect(indices.length).toBe(HorizonBandMath.segmentCount * (HorizonBandMath.stationCount - 1) * 6);
    expect(Math.max(...indices)).toBe(HorizonBandMath.segmentCount * HorizonBandMath.stationCount - 1);
  });
});

describe("the horizon shader's contract", () => {
  // Ported from the Swift `HorizonShaderContractTests`.
  test("sits at the far plane and never discards", () => {
    expect(horizonSource).not.toContain("discard");
    expect(horizonSource).toContain("out.position.z = out.position.w;");
    expect(horizonSource).toContain("override kHorizonGroundSide: bool = false;");
    expect(horizonSource).toContain("above = min(above, 0.0);");
    expect(horizonSource).not.toContain("texture");
  });

  test("pins the profile weights", () => {
    expect(horizonSource).toContain("const kHorizonBandWeight: f32 = 0.85;");
    expect(horizonSource).toContain("const kHorizonGlowWeight: f32 = 0.22;");
  });

  test("the edge angle is the mirrored formula", () => {
    expect(horizonSource).toContain("return asin(clamp(dot(direction, horizon.up), -1.0, 1.0)) + horizon.depression;");
  });
});
