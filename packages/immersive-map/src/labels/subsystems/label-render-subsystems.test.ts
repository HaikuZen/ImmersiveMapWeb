// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `LabelStyleUniformLayoutTests` (the per-draw records
// the label draws write, read against the LabelDraw and SurfaceLabelDraw
// structs of the shaders, and the built-in style's soft labels),
// `RendererLabelDrawerPassTests` (the text draws once per run, fill and halo
// together, the halo resolved to pixels here) and the main-thread side of
// `RouteShieldTests` (a plate's style as the shader reads it) and the halo
// width of `LabelScreenUnitTests`. The draws are
// encoded into a recording pass with fake GPU objects.

import { describe, expect, test } from "vitest";
import { DRAW_RECORD_BYTES } from "../../render/core/draw-parameters.ts";
import type { FrameContext } from "../../render/frame-engine.ts";
import { defaultLabelStyles, labelAppearance } from "../../style/theme.ts";
import { makePlaceTile } from "../../tile/placement/place-tile.ts";
import type { PreparedLabelTextStyle, RouteShieldRunStyle, SurfaceLabelRecord } from "../../tile/store/prepared-labels.ts";
import type { GpuTile } from "../../tile/store/tile-gpu.ts";
import type { LabelSourceTile } from "../base/base-label-cache.ts";
import type { LabelGpu } from "../drawers/label-gpu.ts";
import { SurfaceLabelDepth, SurfaceLabelScale } from "../surface/surface-label-selection.ts";
import type { BaseLabelPrepare } from "./base-label-prepare.ts";
import { type LabelDrawFrame, ScreenLabelSubsystem, SurfaceLabelSubsystem, type SurfaceLabelFrame } from "./label-render-subsystems.ts";

const FLOATS = DRAW_RECORD_BYTES / 4;

/** The frame's draw records without a device: the same 80 byte records `DrawParameters` stages. */
class FakeDrawParameters {
  readonly buffer = new ArrayBuffer(64 * DRAW_RECORD_BYTES);
  readonly f32 = new Float32Array(this.buffer);
  readonly i32 = new Int32Array(this.buffer);
  used = 0;

  allocate(): { instance: number; index: number } {
    const instance = this.used++;
    const index = instance * FLOATS;
    this.f32.fill(0, index, index + FLOATS);
    return { instance, index };
  }

  bindGroup(): GPUBindGroup {
    return "draws" as unknown as GPUBindGroup;
  }

  /** The record of one draw as floats. */
  record(instance: number): number[] {
    return Array.from(this.f32.subarray(instance * FLOATS, (instance + 1) * FLOATS));
  }
}

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A pass that records its calls. */
function recordingPass(): { pass: GPURenderPassEncoder; calls: Call[]; draws: () => { pipeline: unknown; atlas: unknown; vertexCount: number; firstVertex: number; instance: number }[] } {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push({ name, args });
    };
  const pass = { setPipeline: record("setPipeline"), setBindGroup: record("setBindGroup"), setVertexBuffer: record("setVertexBuffer"), draw: record("draw") } as unknown as GPURenderPassEncoder;
  const draws = () => {
    let pipeline: unknown;
    let atlas: unknown;
    const out: { pipeline: unknown; atlas: unknown; vertexCount: number; firstVertex: number; instance: number }[] = [];
    for (const call of calls) {
      if (call.name === "setPipeline") pipeline = call.args[0];
      if (call.name === "setBindGroup" && call.args[0] === 2) atlas = call.args[1];
      if (call.name === "draw") out.push({ pipeline, atlas, vertexCount: call.args[0] as number, firstVertex: call.args[2] as number, instance: call.args[3] as number });
    }
    return out;
  };
  return { pass, calls, draws };
}

const fakeGpu = {
  screenPipeline: (kind: string) => `screen:${kind}`,
  surfacePipeline: (kind: string) => `surface:${kind}`,
  atlasGroups: { bold: "atlas:bold", thin: "atlas:thin", poi: "atlas:poi" },
  drawLayout: "draw layout",
  frameBindGroup: () => "label frame",
  sceneBindGroup: (depth: unknown) => (depth === undefined ? "scene fallback" : "scene depth"),
  writeScene: () => undefined,
  writeFrame: () => undefined,
} as unknown as LabelGpu;

function context(parameters: FakeDrawParameters, pixelsPerPoint = 2): FrameContext {
  return { frameNumber: 1, drawWidth: 800, drawHeight: 600, pixelsPerPoint, planningZoom: 4, frameBindGroup: "tile frame" as unknown as GPUBindGroup, drawParameters: parameters as unknown as FrameContext["drawParameters"] };
}

function textStyle(overrides: Partial<PreparedLabelTextStyle> = {}): PreparedLabelTextStyle {
  return {
    ...labelAppearance({ fillColor: [0.1, 0.2, 0.3], strokeColor: [0.9, 0.8, 0.7], haloEm: 0.25, sizePoints: 12, weight: "bold", opacity: 0.8, haloSoftness: 0.5 }),
    key: 1,
    isPointOfInterest: false,
    sphereFillColor: [1, 1, 1],
    sphereStrokeColor: null,
    ...overrides,
  };
}

const shieldStyle: RouteShieldRunStyle = { shape: "escutcheon", fillColor: [0.1, 0.2, 0.6], borderColor: [1, 1, 1], headerColor: [0.8, 0, 0], headerFraction: 0.25, borderWidthPoints: 1.5, cornerRadiusPoints: 2 };

function span(vertexOffset: number, vertexCount: number) {
  return { vertexOffset, vertexCount };
}

/** A tile of one POI run, one route plate run and one glyph run, its labels the set's from the fifth on. */
function screenSetup(text: PreparedLabelTextStyle, routeStyle: RouteShieldRunStyle = shieldStyle) {
  const gpu = {
    buffer: "tile buffer",
    meta: { labels: { text: { glyphRunStyles: [text], poiIconRunStyles: [textStyle({ fillColor: [0.4, 0.5, 0.6], isPointOfInterest: true })], routeShieldRunStyles: [routeStyle] } } },
    labels: { glyphRuns: [span(640, 12)], poiIconRuns: [span(0, 6)], routeShieldRuns: [span(320, 6)] },
  } as unknown as GpuTile;
  const prepare = { baseCache: { labelCount: 9, drawBatches: [{ gpu, globalLabelStart: 5, labelCount: 4 }] }, roadDraws: [], hasRenderableLabels: true } as unknown as BaseLabelPrepare;
  return prepare;
}

const drawFrame: LabelDrawFrame = { screenMatrix: new Float64Array(16), handover: 0.25, labelOpacity: { names: 0.5, pois: 0.25 } };

describe("ScreenLabelSubsystem draws", () => {
  test("the POI discs, the route plates, then the names, one draw per run", () => {
    const parameters = new FakeDrawParameters();
    const subsystem = new ScreenLabelSubsystem(fakeGpu, screenSetup(textStyle()), () => undefined, () => drawFrame);
    const { pass, draws } = recordingPass();
    subsystem.encode("labels", pass, context(parameters));
    expect(draws().map((draw) => [draw.pipeline, draw.atlas, draw.vertexCount, draw.instance])).toEqual([
      ["screen:poi", "atlas:poi", 6, 0],
      ["screen:routeShield", "atlas:poi", 6, 1],
      ["screen:text", "atlas:bold", 12, 2],
    ]);
  });

  // The text draws once per run: the fragment stage shades the fill and the
  // halo together, so a halo pass under a fill pass would only double the
  // fragments. The halo reaches the shader in device pixels, resolved here
  // from the style's em ratio and the frame's scale.
  test("a name draws its fill and its halo in one draw, the halo in pixels", () => {
    const parameters = new FakeDrawParameters();
    const subsystem = new ScreenLabelSubsystem(fakeGpu, screenSetup(textStyle()), () => undefined, () => drawFrame);
    subsystem.encode("labels", recordingPass().pass, context(parameters, 2));
    const text = parameters.record(2);
    // The fill at a quarter of the handover from the globe's white to its own.
    const fill = [1 + (0.1 - 1) * 0.25, 1 + (0.2 - 1) * 0.25, 1 + (0.3 - 1) * 0.25].map(Math.fround);
    expect(text.slice(0, 4), "colorA: the fill").toEqual([...fill, 1]);
    expect(text.slice(4, 8), "colorB: the halo, its own with no globe colour").toEqual([0.9, 0.8, 0.7, 1].map(Math.fround));
    expect(text.slice(12, 16), "params: halo width and fill bias in pixels, opacity, softness").toEqual([0.25 * 12 * 2, 0.375 * 2, 0.8 * 0.5, 0.5].map(Math.fround));
    expect(parameters.i32[2 * FLOATS + 16], "shift: the tile's first label").toBe(5);
  });

  // An em ratio is what stops the smallest labels carrying the widest halo
  // relative to their strokes: at a fixed ratio the halo shrinks with the
  // text, and it grows with the display.
  test("the halo width tracks both the em size and the display", () => {
    const haloAt = (sizePoints: number, pixelsPerPoint: number): number => {
      const parameters = new FakeDrawParameters();
      const style = textStyle({ sizePoints, haloEm: 0.15 });
      new ScreenLabelSubsystem(fakeGpu, screenSetup(style), () => undefined, () => drawFrame).encode("labels", recordingPass().pass, context(parameters, pixelsPerPoint));
      return parameters.record(2)[12]!;
    };
    expect(haloAt(11, 2)).toBeCloseTo(11 * 0.15 * 2, 4);
    expect(haloAt(11, 3)).toBeCloseTo(11 * 0.15 * 3, 4);
    expect(haloAt(11, 2)).toBeLessThan(haloAt(22, 2));
  });

  test("a POI plate takes its colour, the white icon and the POIs' opacity", () => {
    const parameters = new FakeDrawParameters();
    new ScreenLabelSubsystem(fakeGpu, screenSetup(textStyle()), () => undefined, () => drawFrame).encode("labels", recordingPass().pass, context(parameters));
    const poi = parameters.record(0);
    expect(poi.slice(0, 8)).toEqual([0.4, 0.5, 0.6, 1, 1, 1, 1, 1].map(Math.fround));
    expect(poi[14], "params.z: the plate's opacity times the POIs' factor").toBe(Math.fround(0.8 * 0.25));
    expect(parameters.i32[16]).toBe(5);
  });

  test("a route plate's style is written as the shader reads it", () => {
    const parameters = new FakeDrawParameters();
    new ScreenLabelSubsystem(fakeGpu, screenSetup(textStyle()), () => undefined, () => drawFrame).encode("labels", recordingPass().pass, context(parameters));
    const plate = parameters.record(1);
    expect(plate.slice(0, 12), "the fill, the border, the band").toEqual([0.1, 0.2, 0.6, 1, 1, 1, 1, 1, 0.8, 0, 0, 1].map(Math.fround));
    expect(plate.slice(12, 16), "border width, corner radius, the band's share, the escutcheon").toEqual([1.5, 2, 0.25, 2]);
    expect(parameters.i32[FLOATS + 16]).toBe(5);
  });

  test("a plate in one colour has no band, and each shape has its number", () => {
    for (const [shape, number] of [
      ["rectangle", 0],
      ["capsule", 1],
    ] as const) {
      const parameters = new FakeDrawParameters();
      const style: RouteShieldRunStyle = { ...shieldStyle, shape, headerColor: null };
      new ScreenLabelSubsystem(fakeGpu, screenSetup(textStyle(), style), () => undefined, () => drawFrame).encode("labels", recordingPass().pass, context(parameters));
      const plate = parameters.record(1);
      expect(plate.slice(8, 11), "the band is the fill").toEqual([0.1, 0.2, 0.6].map(Math.fround));
      expect([plate[14], plate[15]]).toEqual([0, number]);
    }
  });

  test("the road names draw one per tile record, on the plane's colours, from their first glyph", () => {
    const parameters = new FakeDrawParameters();
    const style = textStyle({ weight: "thin" });
    const record = { labelStyle: style, glyphVertices: span(96, 18), resident: { gpu: { buffer: "road buffer" } } };
    const prepare = { baseCache: { labelCount: 0, drawBatches: [] }, roadDraws: [{ record, glyphShift: 7 }], hasRenderableLabels: true } as unknown as BaseLabelPrepare;
    const { pass, draws, calls } = recordingPass();
    new ScreenLabelSubsystem(fakeGpu, prepare, () => undefined, () => drawFrame).encode("labels", pass, context(parameters, 2));
    expect(draws().map((draw) => [draw.pipeline, draw.atlas, draw.vertexCount])).toEqual([["screen:roadText", "atlas:thin", 18]]);
    expect(calls.find((call) => call.name === "setVertexBuffer")!.args).toEqual([0, "road buffer", 96, 18 * 32]);
    const text = parameters.record(0);
    expect(text.slice(0, 3), "a road name wears the plane's colour").toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(text[12]).toBe(0.25 * 12 * 2);
    expect(parameters.i32[16]).toBe(7);
  });

  test("nothing draws outside the labels' layer or without labels", () => {
    const parameters = new FakeDrawParameters();
    const { pass, calls } = recordingPass();
    new ScreenLabelSubsystem(fakeGpu, screenSetup(textStyle()), () => undefined, () => drawFrame).encode("surfaceLabels", pass, context(parameters));
    const empty = { baseCache: { labelCount: 0, drawBatches: [] }, roadDraws: [], hasRenderableLabels: false } as unknown as BaseLabelPrepare;
    new ScreenLabelSubsystem(fakeGpu, empty, () => undefined, () => drawFrame).encode("labels", pass, context(parameters));
    expect(calls).toEqual([]);
  });
});

describe("SurfaceLabelSubsystem draws", () => {
  function surfaceRecord(style: PreparedLabelTextStyle): SurfaceLabelRecord {
    return { key: "7", style, placement: { referenceZoom: 3, minimumZoom: null, maximumZoom: null, letterSpacingEm: 0.15 }, vertexStart: 12, vertexCount: 6 };
  }

  function surfaceFrame(style: PreparedLabelTextStyle): SurfaceLabelFrame {
    const gpu = { buffer: "tile buffer", meta: { labels: { surface: [surfaceRecord(style)] } }, labels: { surfaceGlyphs: span(1024, 24) } } as unknown as GpuTile;
    const resident = { tile: { x: 1, y: 1, z: 2 }, gpu } as LabelSourceTile;
    return {
      placements: [makePlaceTile(resident, { tile: resident.tile, worldWrap: 0 })],
      renderSurfaceMode: "flat",
      flatRenderState: { pan: [0, 0], renderMapSize: 8 },
      globe: { panX: 0, panY: 0, radius: 1, transition: 1 },
      tileWorldSize: 2,
      handover: 0.5,
      labelOpacity: { names: 0.5, pois: 1 },
      atlasEmTexels: { bold: 40, thin: 32 },
    };
  }

  test("every halo first, then every fill, each record as the shader reads it", () => {
    const parameters = new FakeDrawParameters();
    const style = textStyle({ sphereFillColor: null });
    const subsystem = new SurfaceLabelSubsystem(fakeGpu, () => surfaceFrame(style));
    const frameContext = context(parameters, 2);
    subsystem.update(frameContext);
    const { pass, draws } = recordingPass();
    subsystem.encode("surfaceLabels", pass, frameContext);
    expect(draws().map((draw) => [draw.pipeline, draw.atlas, draw.vertexCount, draw.firstVertex])).toEqual([
      ["surface:flat", "atlas:bold", 6, 12],
      ["surface:flat", "atlas:bold", 6, 12],
    ]);
    const halo = parameters.record(0);
    const fill = parameters.record(1);
    // tile: the flat origin and the scale of a tile unit. Tile 1/1 of zoom 2 on a map of 8 is 2 units a side at (-2, 0).
    expect(halo.slice(0, 3)).toEqual([-2, 0, Math.fround(2 / 4096)]);
    expect(halo.slice(4, 8), "fillColor with the opacity in alpha").toEqual([0.1, 0.2, 0.3, 0.8 * 0.5].map(Math.fround));
    expect(halo.slice(8, 12), "strokeColor with the opacity in alpha").toEqual([0.9, 0.8, 0.7, 0.8 * 0.5].map(Math.fround));
    const tileUnits = SurfaceLabelScale.tileUnitsPerPoint(2, 3, SurfaceLabelScale.tileScreenPoints(600 / 2, 2));
    expect(halo.slice(12, 16), "params: halo width in atlas texels, the halo pass, tile units per point, softness").toEqual([0.25 * 40, 1, tileUnits, 0.5].map(Math.fround));
    expect(fill[13], "the fill pass").toBe(0);
    expect(halo.slice(16, 20), "screen: the drawable, the pixels per point, the depth").toEqual([800, 600, 2, SurfaceLabelDepth.depth].map(Math.fround));
  });

  test("a label with no halo draws its fill alone", () => {
    const parameters = new FakeDrawParameters();
    const subsystem = new SurfaceLabelSubsystem(fakeGpu, () => surfaceFrame(textStyle({ haloEm: 0 })));
    const frameContext = context(parameters);
    subsystem.update(frameContext);
    const { pass, draws } = recordingPass();
    subsystem.encode("surfaceLabels", pass, frameContext);
    expect(draws()).toHaveLength(1);
    expect(parameters.record(0)[13]).toBe(0);
  });
});

// The names are a little transparent and their halos fade out, the
// countries and the regions lighter still. The water's names wear no halo to
// soften.
describe("the built-in labels", () => {
  test("are laid over the map softly", () => {
    const labels = defaultLabelStyles;
    for (const [name, appearance] of [
      ["city", labels.city],
      ["town", labels.town],
      ["district", labels.district],
      ["poi", labels.poi],
      ["road", labels.road],
    ] as const) {
      expect(appearance.opacity, name).toBe(0.8);
      expect(appearance.haloSoftness, name).toBe(0.5);
    }
    expect(labels.water.opacity).toBe(0.8);
    expect(labels.country.opacity).toBe(0.65);
    expect(labels.country.haloSoftness).toBe(0.5);
    expect(labels.region.opacity).toBe(0.7);
    expect(labels.region.haloSoftness).toBe(0.5);
    expect(labelAppearance({ fillColor: [0, 0, 0], strokeColor: [1, 1, 1], haloEm: 0.1, sizePoints: 12, weight: "bold" }).haloSoftness, "a style that names no softness keeps a halo solid to its edge").toBe(0);
  });
});
