// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `LabelStyleUniformLayoutTests` (the surface labels'
// `SurfaceLabelDraw`, now an 80 byte draw record) and the halo parts of
// `TextShaderStrokeClampTests`, as source contract checks on
// surface-label.wgsl.

import { describe, expect, test } from "vitest";
import { GlobeSurfaceDepthRank } from "../../tile/drawers/depth-rank.ts";
import { DRAW_RECORD_BYTES } from "../../render/core/draw-parameters.ts";
import source from "./surface-label.wgsl?raw";

/** The fields of a WGSL struct, in order, as `name: type`, without their comments. */
function structFields(wgsl: string, name: string): string[] {
  const start = wgsl.indexOf(`struct ${name} {`);
  if (start < 0) throw new Error(`no struct ${name}`);
  const body = wgsl.slice(start + `struct ${name} {`.length, wgsl.indexOf("}", start));
  return body
    .split("\n")
    .map((line) => line.split("//")[0]!.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

describe("surface-label.wgsl", () => {
  test("the surface label draw is the 80 byte draw record", () => {
    expect(structFields(source, "SurfaceLabelDraw")).toEqual(["tile: vec4f", "fillColor: vec4f", "strokeColor: vec4f", "params: vec4f", "screen: vec4f"]);
    expect(5 * 16).toBe(DRAW_RECORD_BYTES);
  });

  test("the halo pass reads its width, its softness and its colour where the draws write them", () => {
    expect(source).toContain("if (draw.params.y > 0.5) {");
    expect(source).toContain("let haloPx = min(draw.params.x * pixelsPerTexel, max(0.5 * screenPxRange - 0.5, 0.0));");
    expect(source).toContain("let fadePx = haloPx * draw.params.w;");
    expect(source).toContain("coverage = smoothstep(-haloPx - 0.5, -haloPx + 0.5 + fadePx, sdfDistance * screenPxRange);");
    expect(source, "the opacity rides in the colours' alpha").toContain("opacity = draw.strokeColor.a;");
    expect(source).toContain("opacity = draw.fillColor.a;");
  });

  test("the atlas range and the real depth scale match the CPU's", () => {
    expect(source).toContain("const kSurfaceLabelDistanceRange: f32 = 24.0;");
    expect(source).toContain("const kSurfaceLabelRealDepthScale: f32 = 1.0 - 1536.0 * 3.2e-6;");
    expect([GlobeSurfaceDepthRank.realGeometryRank, GlobeSurfaceDepthRank.layerDepthStep]).toEqual([1536, 3.2e-6]);
    expect(source, "the label's own depth from the record").toContain("draw.screen.w");
  });
});
