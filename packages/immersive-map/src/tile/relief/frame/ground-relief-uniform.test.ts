// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The relief's uniform against its shader struct, as
// shadows/shadow-shader-layout.test.ts pins the shadows' (the Swift
// `GroundReliefUniform` is nine `float4`, 144 bytes), and what one tile's
// draw writes into it. The terrain side's metres are in
// store/ground-relief-store.test.ts, read off a loaded tile as the Swift test does.

import { describe, expect, test } from "vitest";
import { groundReliefSettings } from "../../../configuration/tile-settings.ts";
import { GroundRelief } from "../lifts/ground-relief.ts";
import relief from "../shaders/ground-relief.wgsl?raw";
import { GroundReliefTile } from "../store/ground-relief-tile.ts";
import { halves } from "../store/half-float.ts";
import { flatAnswer, makeTestRelief } from "../testing/ground-relief-fakes.ts";
import { GroundReliefUniform } from "./ground-relief-uniform.ts";

/** The members of a WGSL struct, `[name, type]`, in order. */
function members(source: string, struct: string): [string, string][] {
  const body = new RegExp(`struct ${struct} \\{([^}]*)\\}`).exec(source)?.[1];
  if (body === undefined) throw new Error(`no struct ${struct}`);
  return [...body.matchAll(/^\s*(\w+): ([\w<>, ]+),/gm)].map((m) => [m[1]!, m[2]!.trim()]);
}

describe("GroundReliefUniform against ground-relief.wgsl", () => {
  test("nine vec4f, member for member, at the CPU's float offsets", () => {
    const list = members(relief, "GroundReliefUniform");
    expect(list.every(([, type]) => type === "vec4f"), "every member a vec4f").toBe(true);
    expect(list.length * 16).toBe(GroundReliefUniform.byteLength);
    expect(GroundReliefUniform.byteLength).toBe(144);
    const offsets = Object.fromEntries(list.map(([name], index) => [name, index * 4]));
    expect(offsets).toEqual(GroundReliefUniform.layout);
  });

  test("the struct is bound where the pipelines bind it", () => {
    expect(relief).toMatch(/@group\(3\) @binding\(0\) var<uniform> relief: GroundReliefUniform;/);
  });
});

describe("GroundReliefUniform.write", () => {
  test("a tile's draw writes its placements, the frame's values and the shading", () => {
    const ground = makeTestRelief(groundReliefSettings({ isEnabled: true, exaggeration: 2 }), () => flatAnswer(0));
    ground.state.setWorldScale([0.5, 0.5], 1000);
    ground.state.setDatum(120);
    const frame = ground.state.frame;
    const terrain = new GroundReliefTile({ id: 1, byteLength: 8 }, 2, halves([0, 0, 0, 0]), { lowerBound: 0, upperBound: 0 });
    const raised = new GroundRelief(terrain, 0.25, 0.5, 0.25, 2);
    const shading = new GroundRelief(terrain, 0.5, 0.75, 0.125, 2);
    const target = new Float32Array(4 + 36).fill(-1);
    const tile = { x: 6, y: 9, z: 4 };
    GroundReliefUniform.write(target, 4, raised, shading, tile, frame, 1000);
    const L = GroundReliefUniform.layout;
    const at = (field: number, count = 4) => [...target.slice(4 + field, 4 + field + count)];
    expect(target[3], "nothing before the offset").toBe(-1);
    expect(at(L.placement)).toEqual([0.25, 0.5, 0.25, Math.fround(frame.worldUnitsPerMetre)]);
    expect(at(L.frame, 2)).toEqual([120, 2]);
    expect(target[4 + L.frame + 2], "the metres the shading's terrain spans").toBe(Math.fround(GroundReliefUniform.terrainSideMetres(shading, tile, frame.worldUnitsPerMetre, 1000)));
    expect(at(L.shading)).toEqual([0.5, 0.75, 0.125, 0]);
    expect(at(L.hillshadeLight)).toEqual([...frame.hillshade.light].map(Math.fround));
    expect(at(L.occlusion)).toEqual([...frame.occlusionUniform].map(Math.fround));
    ground.store.destroy();
  });
});
