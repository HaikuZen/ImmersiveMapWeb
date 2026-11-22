// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A port of the CPU parts of the Swift `ShadowUniformLayoutTests` and
// `ShadowPassGateResolverTests`: the layouts' offsets, the disabled
// uniform, the slots, the mask's uniform and size, the gate.

import { describe, expect, test } from "vitest";
import { groundReliefSettings } from "../configuration/tile-settings.ts";
import { type Mat4, Matrix, mat4Identity, mat4Multiply } from "../math/matrix.ts";
import { GroundShadowMask, GroundShadowMaskUniformLayout, writeGroundShadowMaskUniform } from "./ground-shadow-mask.ts";
import { ShadowCascadeAtlas, shadowCascadeSlots } from "./shadow-cascade-atlas.ts";
import type { ShadowFrameState } from "./shadow-frame-state.ts";
import { ShadowPassGateResolver } from "./shadow-pass-gate.ts";
import { ShadowCascadeUniform, ShadowUniform, ShadowUniformLayout, writeShadowUniform } from "./shadow-uniform.ts";

describe("ShadowUniformLayout", () => {
  test("the cascade's offsets are WGSL's natural layout", () => {
    const C = ShadowUniformLayout.cascade;
    expect(C.byteLength).toBe(112);
    expect([C.worldToShadowTexture, C.tentSpread, C.fadeStartDistance, C.depthBias, C.fadeEndDistance, C.uvMinimum, C.uvMaximum, C.normalOffsetWorld, C.texelSizeUV]).toEqual([
      0, 64, 68, 72, 76, 80, 88, 96, 104,
    ]);
  });

  test("the shadow's offsets are WGSL's natural layout", () => {
    const L = ShadowUniformLayout;
    expect(L.byteLength).toBe(288);
    expect([L.near, L.far, L.eyeAndStrength, L.lightDirection, L.tint, L.fadeCenter]).toEqual([0, 112, 224, 240, 256, 272]);
  });

  test("the writer puts every member at its offset", () => {
    const target = new Float32Array(ShadowUniformLayout.byteLength / 4 + 4).fill(-7);
    const near: ShadowCascadeUniform = {
      worldToShadowTexture: new Float64Array(16).map((_, i) => i + 1),
      tentSpread: 1.5,
      fadeStartDistance: 3,
      depthBias: 0.25,
      fadeEndDistance: 4,
      uvMinimum: [0.125, 0.125],
      uvMaximum: [0.875, 0.875],
      normalOffsetWorld: 0.5,
      texelSizeUV: [1 / 1024, 1 / 1024],
    };
    const uniform: ShadowUniform = { near, far: ShadowCascadeUniform.disabled, eye: [1, 2, 3], strength: 0.22, lightDirection: [0, 0.6, 0.8], tint: [0.88, 0.92, 1], fadeCenter: [9, 10] };
    writeShadowUniform(target, 4, uniform);
    const at = (byte: number) => target[4 + byte / 4]!;
    expect(at(0)).toBe(1);
    expect(at(60)).toBe(16);
    expect(at(64)).toBe(1.5);
    expect(at(72)).toBe(0.25);
    expect(at(84)).toBe(0.125);
    expect(at(88)).toBe(0.875);
    expect(at(96)).toBe(0.5);
    expect(at(104)).toBe(1 / 1024);
    expect(at(112 + 80)).toBe(1);
    expect(at(112 + 88)).toBe(-1);
    expect([at(224), at(228), at(232), at(236)]).toEqual([1, 2, 3, Math.fround(0.22)]);
    expect(at(244)).toBe(Math.fround(0.6));
    expect(at(256)).toBe(Math.fround(0.88));
    expect([at(272), at(276)]).toEqual([9, 10]);
    expect(target[0]).toBe(-7);
    expect(() => writeShadowUniform(new Float32Array(10), 0, uniform)).toThrow(RangeError);
  });

  test("the disabled uniform has no strength and empty rectangles", () => {
    expect(ShadowUniform.disabled.strength).toBe(0);
    expect(ShadowUniform.disabled.near.uvMinimum[0]).toBeGreaterThan(ShadowUniform.disabled.near.uvMaximum[0]);
    expect(ShadowCascadeUniform.isEnabled(ShadowUniform.disabled.far)).toBe(false);
  });

  test("the slots are the slices", () => {
    expect(shadowCascadeSlots).toEqual(["near", "far"]);
    expect(ShadowCascadeAtlas.slice("near")).toBe(0);
    expect(ShadowCascadeAtlas.slice("far")).toBe(1);
    expect(ShadowCascadeAtlas.sliceCount).toBe(2);
    expect(ShadowCascadeAtlas.slotOfCasterLayer("shadowCasters")).toBe("near");
    expect(ShadowCascadeAtlas.slotOfCasterLayer("farShadowCasters")).toBe("far");
    expect(ShadowCascadeAtlas.slotOfCasterLayer("buildingExtrusion")).toBeUndefined();
    expect(ShadowCascadeAtlas.casterLayer("near")).toBe("shadowCasters");
    expect(ShadowCascadeAtlas.casterLayer("far")).toBe("farShadowCasters");
    expect(ShadowCascadeAtlas.depthFormat).toBe("depth16unorm");
  });
});

describe("the ground shadow mask", () => {
  test("the uniform's layout", () => {
    expect(GroundShadowMaskUniformLayout.byteLength).toBe(80);
    expect(GroundShadowMaskUniformLayout.inverseProjectionView).toBe(0);
    expect(GroundShadowMaskUniformLayout.viewportSize).toBe(64);
  });

  test("the uniform inverts the projection-view", () => {
    const projectionView: Mat4 = mat4Multiply(
      new Float64Array(16),
      Matrix.perspectiveMatrix(new Float64Array(16), 1.0, 1.5, 0.1, 100),
      Matrix.translationMatrix(new Float64Array(16), 3, -2, -10),
    );
    const target = new Float32Array(GroundShadowMaskUniformLayout.byteLength / 4);
    expect(writeGroundShadowMaskUniform(target, projectionView, 1290, 2796)).toBe(true);
    const inverse = new Float64Array(target.subarray(0, 16));
    const roundTrip = mat4Multiply(new Float64Array(16), inverse, projectionView);
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) expect(Math.abs(roundTrip[column * 4 + row]! - (column === row ? 1 : 0))).toBeLessThan(1e-4);
    }
    expect([target[16], target[17]]).toEqual([1290, 2796]);
    expect(writeGroundShadowMaskUniform(target, new Float64Array(16), 1, 1)).toBe(false);
  });

  test("the mask covers the drawable", () => {
    expect(GroundShadowMask.maskSize(1290, 2796)).toEqual([516, 1119]);
    expect(GroundShadowMask.maskSize(1291, 2797)).toEqual([517, 1119]);
    expect(GroundShadowMask.format).toBe("r8unorm");
  });
});

describe("ShadowPassGateResolver", () => {
  const state: ShadowFrameState = { lightProjectionView: mat4Identity(), farLightProjectionView: undefined, shadowUniform: ShadowUniform.disabled, mapResolution: 2048 };

  test("no frame state gates off", () => {
    expect(ShadowPassGateResolver.resolve(undefined, { hasBuildingCasters: true, hasModelCasters: true })).toBeUndefined();
  });

  test("no casters gate off", () => {
    expect(ShadowPassGateResolver.resolve(state, { hasBuildingCasters: false, hasModelCasters: false })).toBeUndefined();
  });

  test("any kind of caster gates on", () => {
    expect(ShadowPassGateResolver.resolve(state, { hasBuildingCasters: true, hasModelCasters: false })).toBe(state);
    expect(ShadowPassGateResolver.resolve(state, { hasBuildingCasters: false, hasModelCasters: true })).toBe(state);
  });

  test("the mountains alone gate on", () => {
    expect(ShadowPassGateResolver.resolve(state, { hasBuildingCasters: false, hasModelCasters: false, hasTerrainCasters: true })).toBe(state);
    expect(groundReliefSettings().castsShadows, "on by default").toBe(true);
  });
});
