// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The shader half of the Swift `ShadowUniformLayoutTests`: the WGSL structs
// the CPU writers fill, member for member, so a reordered or retyped member
// fails here and not as a silently wrong shadow. Also the per-draw records
// of the buildings and the trees' tile, which must keep their sizes.

import { describe, expect, test } from "vitest";
import { GroundShadowMask, GroundShadowMaskUniformLayout } from "./ground-shadow-mask.ts";
import { ShadowUniformLayout } from "./shadow-uniform.ts";
import maskSource from "./shaders/ground-shadow-mask.wgsl?raw";
import receiverSource from "./shaders/ground-shadow-receiver.wgsl?raw";
import shadowSource from "./shaders/shadow.wgsl?raw";
import extrudedSource from "../tile/shaders/tile-extruded.wgsl?raw";
import standingSource from "../tile/shaders/standing-frame.wgsl?raw";
import treesSource from "../tile/shaders/trees.wgsl?raw";
import { DRAW_RECORD_BYTES } from "../render/core/draw-parameters.ts";
import { TREE_TILE_BYTES, TreeFrameUniformLayout } from "../tile/pipelines/standing-pipelines.ts";

/** The members of a WGSL struct, `[name, type]`, in order. */
function members(source: string, struct: string): [string, string][] {
  const body = new RegExp(`struct ${struct} \\{([^}]*)\\}`).exec(source)?.[1];
  if (body === undefined) throw new Error(`no struct ${struct}`);
  return [...body.matchAll(/^\s*(?:@[^\n]*?\s)?(\w+): ([\w<>, ]+),/gm)].map((m) => [m[1]!, m[2]!.trim()]);
}

/** WGSL's natural offsets and size of members of these types (the uniform address space rules for them). */
function naturalLayout(list: [string, string][], structs: Record<string, { size: number; align: number }> = {}): { offsets: Record<string, number>; size: number } {
  const known: Record<string, { size: number; align: number }> = {
    f32: { size: 4, align: 4 },
    u32: { size: 4, align: 4 },
    vec2f: { size: 8, align: 8 },
    vec3f: { size: 12, align: 16 },
    vec4f: { size: 16, align: 16 },
    mat4x4f: { size: 64, align: 16 },
    ...structs,
  };
  let offset = 0;
  let maxAlign = 4;
  const offsets: Record<string, number> = {};
  for (const [name, type] of list) {
    const t = known[type];
    if (!t) throw new Error(`unknown type ${type}`);
    offset = Math.ceil(offset / t.align) * t.align;
    offsets[name] = offset;
    offset += t.size;
    maxAlign = Math.max(maxAlign, t.align);
  }
  return { offsets, size: Math.ceil(offset / maxAlign) * maxAlign };
}

describe("ShadowUniformLayout against shadow.wgsl", () => {
  test("ShadowCascade member for member", () => {
    const cascade = naturalLayout(members(shadowSource, "ShadowCascade"));
    const L = ShadowUniformLayout.cascade;
    expect(cascade.size).toBe(L.byteLength);
    expect(cascade.offsets).toEqual({
      worldToShadowTexture: L.worldToShadowTexture,
      tentSpread: L.tentSpread,
      fadeStartDistance: L.fadeStartDistance,
      depthBias: L.depthBias,
      fadeEndDistance: L.fadeEndDistance,
      uvMinimum: L.uvMinimum,
      uvMaximum: L.uvMaximum,
      normalOffsetWorld: L.normalOffsetWorld,
      padding: 100,
      texelSizeUV: L.texelSizeUV,
    });
  });

  test("Shadow member for member", () => {
    const shadow = naturalLayout(members(shadowSource, "Shadow"), { ShadowCascade: { size: 112, align: 16 } });
    const L = ShadowUniformLayout;
    expect(shadow.size).toBe(L.byteLength);
    expect(shadow.offsets).toEqual({
      near: L.near,
      far: L.far,
      eyeAndStrength: L.eyeAndStrength,
      lightDirection: L.lightDirection,
      tint: L.tint,
      fadeCenter: L.fadeCenter,
      padding: 280,
    });
  });

  test("the geometric cutoff and the slices mirror the CPU's", () => {
    expect(shadowSource).toMatch(/kShadowGeometricCutoffStart: f32 = 0\.18;/);
    expect(shadowSource).toMatch(/kShadowGeometricCutoffEnd: f32 = 0\.35;/);
    expect(shadowSource).toMatch(/kShadowNearSlice: u32 = 0u;/);
    expect(shadowSource).toMatch(/kShadowFarSlice: u32 = 1u;/);
  });
});

describe("the ground shadow mask's shaders", () => {
  test("GroundShadowMaskUniform member for member", () => {
    const mask = naturalLayout(members(maskSource, "GroundShadowMaskUniform"));
    expect(mask.size).toBe(GroundShadowMaskUniformLayout.byteLength);
    expect(mask.offsets).toEqual({ inverseProjectionView: 0, viewportSize: 64, padding: 72 });
  });

  test("the ground reads the mask at its resolution scale", () => {
    expect(receiverSource).toContain(`kGroundShadowMaskScale: f32 = ${GroundShadowMask.resolutionScale};`);
  });
});

describe("the standing records", () => {
  test("a building draw fills the shared 80-byte record", () => {
    expect(naturalLayout(members(extrudedSource, "BuildingDraw")).size).toBe(DRAW_RECORD_BYTES);
  });

  test("a tree tile fits its dynamic-offset binding", () => {
    expect(naturalLayout(members(treesSource, "TreeTile")).size).toBe(TREE_TILE_BYTES);
  });

  test("TreeFrame member for member", () => {
    const frame = naturalLayout(members(standingSource, "TreeFrame"));
    const L = TreeFrameUniformLayout;
    expect(frame.size).toBe(L.byteLength);
    expect(frame.offsets).toEqual({ lightDirection: L.lightDirection, crownColor: L.crownColor, crownShadeColor: L.crownShadeColor, trunkColor: L.trunkColor, crown: L.crown });
  });
});
