// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { StageOverrides } from "./stage-constants.ts";

const source = `
override kMorph: bool = false;
override kBias: f32 = 0.0;
override kScaled: f32 = kBase * 2.0;
override kBase: f32 = 1.0;
override kUnused: u32 = 0u; // kBias in a comment is no use
var<private> pulled: f32 = kPull;
override kPull: f32 = 0.0;
const kExtent: f32 = 4096.0;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@group(0) @binding(0) var<uniform> camera: mat4x4f;

fn surface(p: vec2f) -> vec4f {
    /* kUnused inside a block comment */
    if (kMorph) { return vec4f(p, 0.0, 1.0); }
    return camera * vec4f(p / kExtent, 0.0, 1.0);
}

fn deeper(p: vec2f) -> f32 { return p.x * kScaled + pulled; }

@vertex
fn vertexMain(@location(0) p: vec2f) -> Out {
    var out: Out;
    out.position = surface(p);
    out.uv = vec2f(deeper(p));
    return out;
}

@fragment
fn fragmentMain(in: Out) -> @location(0) vec4f {
    return vec4f(in.uv, kBias, 1.0);
}
`;

describe("StageOverrides", () => {
  const overrides = StageOverrides.of(source);

  it("follows the entry point through the functions it calls, the overrides' initializers and the private variables'", () => {
    expect([...overrides.used("vertexMain")].sort()).toEqual(["kBase", "kMorph", "kPull", "kScaled"]);
  });

  it("does not count a name in a comment", () => {
    expect([...overrides.used("fragmentMain")]).toEqual(["kBias"]);
  });

  it("keeps for each stage only the constants it uses, and none where it uses none", () => {
    const shared = { kMorph: 1, kBias: 0.5, kUnused: 3 };
    expect(overrides.constants("vertexMain", shared)).toEqual({ kMorph: 1 });
    expect(overrides.constants("fragmentMain", shared)).toEqual({ kBias: 0.5 });
    expect(overrides.constants("fragmentMain", { kMorph: 1 })).toBeUndefined();
  });

  it("reads a source once", () => {
    expect(StageOverrides.of(source)).toBe(overrides);
  });

  it("names a missing entry point", () => {
    expect(() => overrides.used("missing")).toThrow("no entry point missing");
  });
});
