// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `PinGPUStructLayoutTests` and `PinRenderShaderShapeTests`
// as source contract checks on pin.wgsl and its TypeScript mirrors.

import { describe, expect, test } from "vitest";
import { PIN_FRAME_UNIFORM_BYTES, PIN_RECORD_BYTES, PinFrameUniformLayout, PinRecordLayout, halfFloats } from "../drawers/pins-gpu.ts";
import source from "./pin.wgsl?raw";

/** The fields of a WGSL struct, in order, as [name, type], without their comments. */
function structFields(wgsl: string, name: string): [string, string][] {
  const start = wgsl.indexOf(`struct ${name} {`);
  if (start < 0) throw new Error(`no struct ${name}`);
  const body = wgsl.slice(start + `struct ${name} {`.length, wgsl.indexOf("\n}", start));
  return body
    .split("\n")
    .map((line) => line.split("//")[0]!.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => line.split(":").map((part) => part.trim()) as [string, string]);
}

const sizes: Record<string, [number, number]> = { f32: [4, 4], u32: [4, 4], vec2f: [8, 8], vec4f: [16, 16], mat4x4f: [64, 16] };

/** Each field's byte offset by WGSL's layout rules, and the struct's size, the nested structs known by `nested`. */
function layout(wgsl: string, name: string): { offsets: Record<string, number>; size: number; align: number } {
  let offset = 0;
  let align = 4;
  const offsets: Record<string, number> = {};
  for (const [field, type] of structFields(wgsl, name)) {
    const [size, fieldAlign] = sizes[type] ?? ((): [number, number] => {
      const inner = layout(wgsl, type);
      return [inner.size, inner.align];
    })();
    offset = Math.ceil(offset / fieldAlign) * fieldAlign;
    offsets[field] = offset;
    offset += size;
    align = Math.max(align, fieldAlign);
  }
  return { offsets, size: Math.ceil(offset / align) * align, align };
}

describe("pin.wgsl layouts", () => {
  test("the pin record matches its TypeScript mirror", () => {
    const record = layout(source, "PinRecord");
    expect(record.size).toBe(PIN_RECORD_BYTES);
    for (const [field, word] of Object.entries(PinRecordLayout)) {
      if (field === "words") continue;
      expect(record.offsets[field], field).toBe(word * 4);
    }
  });

  test("the frame uniform matches its TypeScript mirror", () => {
    const frame = layout(source, "PinFrameUniform");
    expect(frame.size).toBe(PIN_FRAME_UNIFORM_BYTES);
    const style = layout(source, "PinStyleGPU");
    expect(style.size).toBe(80);
    const l = PinFrameUniformLayout;
    expect(frame.offsets.screenMatrix).toBe(l.screenMatrix * 4);
    expect(frame.offsets.style).toBe(l.style * 4);
    expect(style.offsets.sizePx! + frame.offsets.style!).toBe(l.styleSizePx * 4);
    expect(style.offsets.fillColor! + frame.offsets.style!).toBe(l.styleFillColor * 4);
    expect(style.offsets.frameless! + frame.offsets.style!).toBe(l.styleFrameless * 4);
    expect(style.offsets.distanceInAlpha! + frame.offsets.style!).toBe(l.styleDistanceInAlpha * 4);
    expect(frame.offsets.beamPinCenterOffsetPx).toBe(l.beamPinCenterOffsetPx * 4);
    expect(frame.offsets.beamPinBodyHalfMinPx).toBe(l.beamPinBodyHalfMinPx * 4);
    expect(frame.offsets.beamColor).toBe(l.beamColor * 4);
    expect(frame.offsets.badgeSizePx).toBe(l.badgeSizePx * 4);
    expect(frame.offsets.badgeOriginPx).toBe(l.badgeOriginPx * 4);
  });
});

describe("pin.wgsl shapes", () => {
  test("the pin morphs from the shape's field into the body circle", () => {
    expect(source).toContain("decodeSignedDistanceTexels");
    expect(source).toContain("textureSample(sdfTexture");
    expect(source).toContain("let circleDistanceTexels");
    expect(source).toContain("mix(pinDistanceTexels, circleDistanceTexels, saturate(in.morph))");
    expect(source).not.toContain("smoothstep(-edgeWidthTexels, edgeWidthTexels, pinDistanceTexels)");
  });

  test("the counters follow each pin's screen size scale and its compression", () => {
    expect(source).toContain("let screenSizeScale = max(pin.screenSizeScale, 0.0);");
    expect(source).toContain("(frame.badgeOriginPx + uv * frame.badgeSizePx) * screenSizeScale");
    expect(source).toContain("out.contentAlpha = pin.badgeContentAlpha;");
    expect(source).toContain("color.a * in.visibilityAlpha * in.contentAlpha");
  });

  test("the pins fade by their screen point's visibility", () => {
    expect(source).toContain("out.visibilityAlpha = pin.visibilityAlpha;");
    expect(source).toContain("color.a * in.visibilityAlpha");
    expect(source).toContain("picture.a * in.visibilityAlpha");
  });

  test("the beam starts at the true anchor and follows the compression", () => {
    expect(source).toContain("let anchor = pin.beamAnchor;");
    expect(source).toContain("frame.beamPinCenterOffsetPx * pin.beamScale");
    expect(source).toContain("frame.beamPinBodyHalfMinPx * pin.beamScale");
    expect(source).toContain("* pin.beamAnchorAlpha");
    expect(source).toContain("smoothstep(kDisplacedRevealStartPx, kDisplacedRevealEndPx, length(pin.beamOffset))");
    expect(source).toContain("let taper = in.taper * sqrt(in.taper);");
    expect(source).not.toContain("pinAnchorDotVertex");
  });
});

describe("halfFloats", () => {
  test("encodes the field's values as IEEE halves", () => {
    expect([...halfFloats(Float32Array.of(0, 0.5, 1, 0.25, 0.75))]).toEqual([0x0000, 0x3800, 0x3c00, 0x3400, 0x3a00]);
    // 1/3 rounds to the nearest half.
    expect(halfFloats(Float32Array.of(1 / 3))[0]).toBe(0x3555);
  });
});
