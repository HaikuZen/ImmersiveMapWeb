// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `GlobeSphereVertexPathTests`, `GlobeVectorSurfaceUniformLayoutTests`
// and `GlobeLineDashScaleTests`, with the frame uniform's layout pinned against globe.wgsl.

import { describe, expect, test } from "vitest";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { mat4Identity } from "../math/matrix.ts";
import { TileSourceStencilPriority } from "../tile/drawers/depth-rank.ts";
import { GlobeFrameConstants, GlobeLineDashScale, GlobeSphereVertexPath, GlobeSurfaceTile } from "./globe-frame-constants.ts";
import { GlobeFrameUniformLayout, writeGlobeFrameUniform } from "./globe-frame-uniform.ts";
import { GlobeLight } from "./globe-light.ts";
import globeSource from "./shaders/globe.wgsl?raw";
import sphereSource from "../tile/shaders/tile-sphere.wgsl?raw";

const f32 = Math.fround;

describe("GlobeSphereVertexPath", () => {
  test("the pure sphere is transition zero on the sphere", () => {
    expect(GlobeSphereVertexPath.isPureSphere("spherical", 0)).toBe(true);
  });
  test("the morph takes the full path", () => {
    expect(GlobeSphereVertexPath.isPureSphere("spherical", 0.01)).toBe(false);
  });
  test("the flat world never takes it", () => {
    expect(GlobeSphereVertexPath.isPureSphere("flat", 1)).toBe(false);
  });
});

describe("GlobeFrameConstants", () => {
  test("the constants mirror the shader helpers term for term", () => {
    const globe = { panX: 0.3, panY: -0.2, radius: 1000, transition: 0.4 };
    const c = GlobeFrameConstants.make(globe, mat4Identity());
    const panLatitude = globe.panY * ImmersiveMapProjection.maxMercatorLatitude;
    const panLongitude = globe.panX * Math.PI;
    expect(c.panLatitude).toBe(panLatitude);
    expect(c.panLongitude).toBe(panLongitude);
    expect(c.mapSize).toBeCloseTo(2 * Math.PI * globe.radius * ((1 - globe.transition) * Math.cos(panLatitude) + globe.transition), 9);
    expect(c.panMercatorY).toBe(ImmersiveMapProjection.yMercatorNormalized(panLatitude));
    expect(c.curvature).toBeCloseTo(0.6 / 1000, 12);
    // The row-vector layout the shaders multiply with.
    expect([...c.rotation.slice(0, 4)]).toEqual([Math.cos(-panLongitude), 0, -Math.sin(-panLongitude), 0]);
    expect([...c.rotation.slice(12, 16)]).toEqual([0, 0, 0, 1]);
  });

  test("sphereWorld puts the view's centre at the origin and the planet's centre a radius behind it", () => {
    const globe = { panX: -0.4, panY: 0.25, radius: 500, transition: 0 };
    const c = GlobeFrameConstants.make(globe, mat4Identity());
    const w = c.sphereWorld;
    expect([w[12], w[13], w[14]]).toEqual([0, 0, -500]);
    // The unit direction of the view's centre (the pan's longitude is
    // the centre's, negated: ImmersiveMapProjection.globePan) lands at the origin.
    const lat = globe.panY * ImmersiveMapProjection.maxMercatorLatitude;
    const lon = -globe.panX * Math.PI;
    const d = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)] as const;
    const p = [0, 1, 2].map((row) => w[row]! * d[0] + w[4 + row]! * d[1] + w[8 + row]! * d[2] + w[12 + row]!);
    for (const v of p) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  test("sphereClip is the camera matrix over sphereWorld", () => {
    const camera = mat4Identity();
    camera[0] = 2;
    camera[14] = 3;
    const c = GlobeFrameConstants.make({ panX: 0.1, panY: 0.1, radius: 10, transition: 0 }, camera);
    expect(c.sphereClip[0]).toBeCloseTo(2 * c.sphereWorld[0]!, 12);
    expect(c.sphereClip[14]).toBeCloseTo(c.sphereWorld[14]! + 3, 12);
  });
});

describe("GlobeSurfaceTile", () => {
  test("the tile's place in the world uv, as the shaders read it", () => {
    expect(GlobeSurfaceTile.of({ x: 3, y: 5, z: 4 })).toEqual({ uvOrigin: [3 / 16, 5 / 16], uvScale: 1 / 16, referenceWorldX: 3.5 / 16 });
    const record = new Float32Array(20);
    GlobeSurfaceTile.write(record, 0, { x: 3, y: 5, z: 4 });
    expect([...record.slice(0, 4)]).toEqual([3 / 16, 5 / 16, 1 / 16, 3.5 / 16]);
  });

  test("the sphere's draw record keeps the plane's 80 bytes", () => {
    expect(sphereSource).toMatch(/struct SphereTileDraw \{\s*uvOrigin: vec2f,\s*uvScale: f32,\s*referenceWorldX: f32,\s*unused: array<vec4f, 3>,\s*depthOffset: f32,\s*depthRankStep: f32,\s*alphaScale: f32,\s*dashUnitsPerPoint: f32,\s*\}/);
  });

  test("the stencil priority orders finer sources higher, above the cleared stencil", () => {
    expect(TileSourceStencilPriority.reference(6)).toBeGreaterThan(TileSourceStencilPriority.reference(5));
    expect(TileSourceStencilPriority.reference(0)).toBe(1);
    expect(TileSourceStencilPriority.reference(16)).toBe(17);
    expect(TileSourceStencilPriority.reference(20)).toBe(17);
    expect(TileSourceStencilPriority.reference(-1)).toBe(1);
  });
});

describe("GlobeLineDashScale", () => {
  test("coarse tiles keep the z1 dash proportion", () => {
    expect(GlobeLineDashScale.coarseTileDashScale(0)).toBe(0.7);
    expect(GlobeLineDashScale.coarseTileDashScale(1)).toBe(0.7);
    expect(GlobeLineDashScale.coarseTileDashScale(2)).toBe(0.9);
    expect(GlobeLineDashScale.coarseTileDashScale(3)).toBe(1.0);
  });
});

describe("GlobeFrameUniformLayout", () => {
  test("mirrors the shader struct member for member", () => {
    const body = /struct GlobeFrame \{([^}]*)\}/.exec(globeSource)![1]!;
    const members = [...body.matchAll(/^\s*(\w+): (\w+),/gm)].map((m) => [m[1], m[2]]);
    expect(members).toEqual([
      ["sphereClip", "mat4x4f"],
      ["sphereWorld", "mat4x4f"],
      ["pan", "vec2f"],
      ["radius", "f32"],
      ["transition", "f32"],
      ["mapSize", "f32"],
      ["panMercatorY", "f32"],
      ["handover", "f32"],
      ["padding", "f32"],
      ["lightAndStrength", "vec4f"],
      ["nightColorAndSoftness", "vec4f"],
    ]);
    // WGSL's natural layout of those members.
    const sizes: Record<string, number> = { mat4x4f: 64, vec4f: 16, vec2f: 8, f32: 4 };
    let offset = 0;
    const offsets: Record<string, number> = {};
    for (const [name, type] of members) {
      const size = sizes[type!]!;
      offset = Math.ceil(offset / Math.min(size, 16)) * Math.min(size, 16);
      offsets[name!] = offset;
      offset += size;
    }
    expect(offset).toBe(GlobeFrameUniformLayout.byteLength);
    for (const name of ["sphereClip", "sphereWorld", "pan", "radius", "transition", "mapSize", "panMercatorY", "handover", "lightAndStrength", "nightColorAndSoftness"] as const) {
      expect(offsets[name]).toBe(GlobeFrameUniformLayout[name]);
    }
  });

  test("writes every value at its offset", () => {
    const globe = { panX: 0.25, panY: -0.5, radius: 64, transition: 0.3 };
    const constants = GlobeFrameConstants.make(globe, mat4Identity());
    const light: GlobeLight = { lightAndStrength: [0, 0.6, 0.8, 0.5], nightColorAndSoftness: [0.1, 0.2, 0.3, 0.25] };
    const target = new Float32Array(GlobeFrameUniformLayout.byteLength / 4);
    writeGlobeFrameUniform(target, { globe, constants, light, handover: 0.75 });
    const at = (byteOffset: number) => target[byteOffset / 4];
    expect(at(GlobeFrameUniformLayout.sphereWorld + 56)).toBe(f32(constants.sphereWorld[14]!));
    expect([at(GlobeFrameUniformLayout.pan), at(GlobeFrameUniformLayout.pan + 4)]).toEqual([0.25, -0.5]);
    expect(at(GlobeFrameUniformLayout.radius)).toBe(64);
    expect(at(GlobeFrameUniformLayout.transition)).toBe(f32(0.3));
    expect(at(GlobeFrameUniformLayout.mapSize)).toBe(f32(constants.mapSize));
    expect(at(GlobeFrameUniformLayout.panMercatorY)).toBe(f32(constants.panMercatorY));
    expect(at(GlobeFrameUniformLayout.handover)).toBe(0.75);
    expect(at(GlobeFrameUniformLayout.lightAndStrength + 12)).toBe(0.5);
    expect(at(GlobeFrameUniformLayout.nightColorAndSoftness + 12)).toBe(0.25);
  });
});
