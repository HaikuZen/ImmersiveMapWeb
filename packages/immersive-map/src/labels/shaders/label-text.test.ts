// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TextShaderStrokeClampTests` as source contract checks
// on label-text.wgsl (the port of TextShader.metal, LabelTextVertex.metal,
// RoadLabelTextVertex.metal, PoiSprite.metal and RouteShield.metal), with the
// shader side of `RouteShieldTests`, `LabelStyleUniformLayoutTests` and
// `LabelScreenUnitTests`.

import { describe, expect, test } from "vitest";
import { DRAW_RECORD_BYTES } from "../../render/core/draw-parameters.ts";
import labelGpuSource from "../drawers/label-gpu.ts?raw";
import source from "./label-text.wgsl?raw";

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

/** The text of one WGSL function, from its `fn` to the closing brace at the start of a line. */
function functionBody(wgsl: string, name: string): string {
  const start = wgsl.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error(`no fn ${name}`);
  return wgsl.slice(start, wgsl.indexOf("\n}", start) + 2);
}

describe("label-text.wgsl", () => {
  test("the text atlas range is the triple precision one", () => {
    expect(source).not.toContain("vec2f(8.0)");
    expect(source).not.toMatch(/kLabelDistanceRange: f32 = 8\.0/);
    expect(source).toContain("const kLabelDistanceRange: f32 = 24.0;");
    expect(source).toContain("vec2f(kLabelDistanceRange)");
  });

  test("the halo distance comes from the MTSDF alpha", () => {
    expect(functionBody(source, "sampleGlyphDistances")).toContain("texel.a - 0.5");
    expect(source).toContain("sdfPxDist");
    // The halo ends where it always did and fades in over its softness's share of its width.
    const shade = functionBody(source, "shadeGlyph");
    expect(shade).toContain("let fadePx = strokeWidthPx * draw.params.w;");
    expect(shade).toContain("let outer = smoothstep(-strokeWidthPx - 0.5, -strokeWidthPx + 0.5 + fadePx, sdfPxDist);");
  });

  // A class that asks for no halo (the POIs) must get none: the fill and the
  // outer edge come from two different distance fields, so their difference
  // at zero width is not reliably zero.
  test("a zero width stroke is skipped rather than differenced", () => {
    expect(source).toContain("let stroke = select(0.0, clamp(outer - fill, 0.0, 1.0), strokeWidthPx > 0.0);");
  });

  test("the base text fragment caps the stroke before it fills the glyph quad", () => {
    const base = functionBody(source, "labelTextFragment");
    expect(base).not.toContain("max(screenPxRange - 0.75, 0.75)");
    expect(base).toContain("max(0.5 * screenPxRange - 0.5, 0.0)");
    expect(functionBody(source, "roadLabelTextFragment"), "the road text keeps the same cap").toContain("max(0.5 * screenPxRange - 0.5, 0.0)");
  });

  // A hidden label (lost its collision, a duplicate, faded out, beyond the
  // horizon) leaves the clip volume in the vertex stage, so the rasterizer
  // drops it whole: alpha 0 alone would still shade every fragment of its
  // quads.
  test("hidden labels leave the clip volume instead of drawing transparent", () => {
    expect(functionBody(source, "hiddenLabelClipPosition"), "outside the volume on one side: a whole quad there is trivially rejected").toContain("return vec4f(-2.0, -2.0, 0.0, 1.0);");
    for (const name of ["labelVertex", "roadLabelVertex"]) {
      expect(functionBody(source, name), `${name} must move a hidden label out of the clip volume`).toContain("if (!visible) {\n        out.position = hiddenLabelClipPosition();");
    }
    expect(functionBody(source, "labelVertex"), "a label faded to nothing is hidden too").toContain("label.fadeSize.x > 0.0");
    expect(functionBody(source, "roadLabelVertex"), "a road glyph faded to nothing is hidden too").toContain("glyph.placement.w > 0.0");
  });

  // One text pass: the fragment writes a depth that orders fill over halo
  // across neighbouring glyph quads, both just short of the far plane the
  // labels rasterize at.
  test("the text fragments order the fill over the halo through depth", () => {
    expect(source).toContain("@builtin(frag_depth) depth: f32,");
    expect(source).toContain("const kLabelFillDepth: f32 = 0.99999976;");
    expect(source).toContain("const kLabelHaloDepth: f32 = 0.99999988;");
    expect(source).toContain("out.depth = select(select(1.0, kLabelHaloDepth, stroke > 0.0), kLabelFillDepth, fill > 0.0);");
    expect(source).toContain("fn labelTextFragment(in: LabelVertexOut) -> TextFragmentOut");
    expect(source).toContain("fn roadLabelTextFragment(in: LabelVertexOut) -> TextFragmentOut");
    const fill = Math.fround(0.99999976);
    const halo = Math.fround(0.99999988);
    expect(fill, "the fill is nearer, so a later halo fails less-equal against it").toBeLessThan(halo);
    expect(halo, "and a later fill still passes over a halo and over the far plane").toBeLessThan(1);
    expect(fill, "distinct in float32").not.toBe(halo);
    expect(labelGpuSource, "the screen labels test less-equal and write their depth").toContain('depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less-equal" }');
  });

  // The record the draws write (label-render-subsystems.ts) and the struct
  // the shader reads: a field one side has and the other lacks shifts every
  // field after it.
  test("the per-draw record is 80 bytes of four colours and parameters, then the shift", () => {
    expect(structFields(source, "LabelDraw")).toEqual(["colorA: vec4f", "colorB: vec4f", "colorC: vec4f", "params: vec4f", "shift: i32", "unused0: i32", "unused1: i32", "unused2: i32"]);
    expect(4 * 16 + 4 * 4).toBe(DRAW_RECORD_BYTES);
    expect(structFields(source, "LabelFrameRecord"), "the 32 byte frame record (LabelFrameRecordLayout)").toEqual(["screenVisibleScale: vec4f", "fadeSize: vec4f"]);
    expect(structFields(source, "RoadGlyphRecord"), "the 32 byte road glyph record (RoadGlyphRecordLayout)").toEqual(["placement: vec4f", "glyphLayout: vec4f"]);
  });

  test("the text, the POI discs and the route plates read their parameters where the draws write them", () => {
    const shade = functionBody(source, "shadeGlyph");
    expect(shade, "the opacity").toContain("draw.params.z");
    expect(shade, "the fill and the halo colours").toContain("fill * draw.colorA.rgb + stroke * draw.colorB.rgb");
    expect(functionBody(source, "labelTextFragment"), "the halo width and the fill bias in pixels").toContain("min(draw.params.x,");
    expect(functionBody(source, "labelTextFragment")).toContain("+ draw.params.y");
    // The POI plate's opacity after the two colours (the Swift PoiIconStyle).
    expect(functionBody(source, "poiSpriteFragment")).toContain("return vec4f(color, alpha * draw.params.z);");
  });

  // The route plates' shapes: 0 the rectangle, 1 the capsule, 2 the
  // escutcheon, the numbers the draws write.
  test("the route plate shapes are the numbers the draws write", () => {
    const fragment = functionBody(source, "routeShieldFragment");
    expect(fragment).toContain("let shape = u32(draw.params.w);");
    expect(fragment).toContain("let distance = select(select(rectangle, escutcheon, shape == 2u), capsule, shape == 1u);");
    expect(fragment, "the border width").toContain("draw.params.x");
    expect(fragment, "the band's share, none at 0").toContain("if (draw.params.z > 0.0) {");
    expect(fragment, "the band's colour").toContain("draw.colorC.rgb");
  });

  // The shaders are where points become pixels. If a label vertex stage ever
  // stops applying the scale, labels silently render at reference size on
  // every display.
  test("every label vertex stage applies the display's scale", () => {
    expect(functionBody(source, "labelVertex"), "the names, the POI discs and the route plates").toContain("frame.pixelsPerPoint");
    expect(functionBody(source, "roadLabelVertex"), "the road names").toContain("frame.pixelsPerPoint");
  });
});
