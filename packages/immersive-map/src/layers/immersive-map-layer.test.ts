// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DRAW_RECORD_BYTES } from "../render/core/draw-parameters.ts";
import { LayerMeshLayout } from "./cache/layer-mesh-file.ts";
import { ImmersiveMapLayer, ImmersiveMapPolygonStyle, layerStyleValues } from "./immersive-map-layer.ts";
import { ImmersiveMapLayersController } from "./immersive-map-layers-controller.ts";
import { LAYER_CORNER_SLOTS, LAYER_LINE_TEMPLATE, LayerDepth } from "./layer-pipeline.ts";
import { FixedLayerRenderSource } from "./layer-render-source.ts";
import { noMeshCache, testLayerJobs } from "./testing/layer-test-jobs.ts";

const controllerOf = (layers: Parameters<ImmersiveMapLayersController["set"]>[0] = []) => new ImmersiveMapLayersController({ layers, jobs: testLayerJobs(), meshCache: noMeshCache() });
const layer = (id: string, isVisible = true) => ImmersiveMapLayer.make({ id, source: "squares", isVisible });

describe("ImmersiveMapLayer", () => {
  test("a layer's mesh depends on its source and styles alone", () => {
    const first = ImmersiveMapLayer.make({ source: "zones" });
    expect(ImmersiveMapLayer.equals(first, ImmersiveMapLayer.make({ source: "zones" }))).toBe(true);
    // A layer goes by its source's name unless it is given an id.
    expect(first.id).toBe("zones");
    expect(ImmersiveMapLayer.make({ id: "outline", source: "zones" }).id).toBe("outline");

    const hidden = ImmersiveMapLayer.make({ ...first, isVisible: false });
    expect(ImmersiveMapLayer.equals(first, hidden)).toBe(false);
    // Hiding a layer does not build it again, nor does how the terrain hides it.
    expect(ImmersiveMapLayer.meshKey(first, 1)).toBe(ImmersiveMapLayer.meshKey(hidden, 1));
    expect(ImmersiveMapLayer.meshKey(first, 1)).toBe(ImmersiveMapLayer.meshKey(ImmersiveMapLayer.make({ ...first, hidesBehindTerrain: true }), 1));

    const restyled = ImmersiveMapLayer.make({ ...first, polygonStyle: { ...first.polygonStyle, strokeWidthPoints: 9 } });
    expect(ImmersiveMapLayer.meshKey(first, 1)).not.toBe(ImmersiveMapLayer.meshKey(restyled, 1));
    // A source registered with other data builds its layers again.
    expect(ImmersiveMapLayer.meshKey(first, 1)).not.toBe(ImmersiveMapLayer.meshKey(first, 2));
  });

  test("a style takes the defaults it is not given, and no width below zero", () => {
    const style = ImmersiveMapPolygonStyle.make({ strokeWidthPoints: -3 });
    expect(style.strokeWidthPoints).toBe(0);
    expect(style.fillColor).toEqual([0.18, 0.47, 0.96, 0.25]);
    const values = layerStyleValues(ImmersiveMapLayer.make({ source: "a" }));
    expect(values.length).toBe(24);
    expect(values[8]).toBe(2);
    expect(values[13]).toBe(3);
    expect(values[18]).toBe(4);
  });

  test("a layer draws at the zooms of its range while it is visible", () => {
    const ranged = ImmersiveMapLayer.make({ source: "a", zoomRange: { lowerBound: 10, upperBound: 12 } });
    expect(ImmersiveMapLayer.draws(ranged, 9.9)).toBe(false);
    expect(ImmersiveMapLayer.draws(ranged, 10)).toBe(true);
    expect(ImmersiveMapLayer.draws(ranged, 12)).toBe(true);
    expect(ImmersiveMapLayer.draws(ImmersiveMapLayer.make({ ...ranged, isVisible: false }), 11)).toBe(false);
  });
});

describe("ImmersiveMapLayersController", () => {
  test("the controller keeps the order and one layer to an id", () => {
    const controller = controllerOf([layer("a"), layer("b")]);
    expect(controller.layers.map((l) => l.id)).toEqual(["a", "b"]);

    controller.upsert(layer("c"));
    controller.upsert(layer("a", false));
    // A layer set again keeps its place.
    expect(controller.layers.map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(controller.layer("a")?.isVisible).toBe(false);

    controller.remove("b");
    expect(controller.layers.map((l) => l.id)).toEqual(["a", "c"]);
    expect(controller.layer("b")).toBeUndefined();

    // The last layer given under an id, in the place of the first.
    controller.set([layer("x"), layer("y"), layer("x", false)]);
    expect(controller.layers.map((l) => l.id)).toEqual(["x", "y"]);
    expect(controller.layer("x")?.isVisible).toBe(false);

    controller.setVisible("x", true);
    expect(controller.layer("x")?.isVisible).toBe(true);
    controller.remove(["x", "y"]);
    expect(controller.layers).toEqual([]);

    controller.set([{ source: "plain" }]);
    controller.clear();
    expect(controller.layers).toEqual([]);
  });

  test("the controller tells the map of a change alone", () => {
    const controller = controllerOf();
    const owner = {};
    let changes = 0;
    controller.setChangeHandler(() => changes++, owner);

    controller.set([layer("a")]);
    expect(changes).toBe(1);
    // The same layers again ask for no frame.
    controller.set([layer("a")]);
    controller.upsert(layer("a"));
    controller.setVisible("a", true);
    controller.remove("missing");
    expect(changes).toBe(1);

    controller.setVisible("a", false);
    expect(changes).toBe(2);

    // A stale owner's detach leaves the handler of the one that holds it.
    controller.clearChangeHandler({});
    controller.clear();
    expect(changes).toBe(3);
    controller.clearChangeHandler(owner);
    controller.set([layer("b")]);
    expect(changes).toBe(3);
  });

  test("data in memory needs an identity", () => {
    const controller = controllerOf();
    expect(() => controller.register("a", { geoJSON: "{}" } as never)).toThrow(TypeError);
    expect(() => controller.register("b", { points: [] } as never)).toThrow(TypeError);
    controller.register("c", { geoJSON: new URL("https://example.invalid/c.geojson") });
    controller.register("d", { identity: "v1", points: [] });
    expect(controller.sourceNames).toEqual(["c", "d"]);
    controller.unregister("c");
    expect(controller.sourceNames).toEqual(["d"]);
  });

  test("a fixed source holds its layers", () => {
    expect(new FixedLayerRenderSource().currentLayers).toEqual([]);
    expect(new FixedLayerRenderSource().sourceLibrary).toBeUndefined();
    const controller = controllerOf([layer("a")]);
    const source = new FixedLayerRenderSource(controller);
    controller.set([layer("b")]);
    // The layers are the controller's as they were.
    expect(source.currentLayers.map((l) => l.id)).toEqual(["a"]);
    expect(source.sourceLibrary).toBe(controller.library);
  });
});

describe("the GPU layouts", () => {
  test("the structs and the draw record match the shaders", () => {
    expect(LayerMeshLayout.fillVertexStride).toBe(12);
    expect(LayerMeshLayout.lineSegmentStride).toBe(24);
    expect(LayerMeshLayout.discStride).toBe(24);
    // layers.wgsl's LayerDraw is five vec4s, one draw record.
    expect(DRAW_RECORD_BYTES).toBe(5 * 16);
    expect(LayerDepth.depth).toBeCloseTo(1 - 1210 * 3.2e-6, 12);
  });

  test("the triangles of a segment's shape name its ten corners alone", () => {
    expect(LAYER_LINE_TEMPLATE.length % 3).toBe(0);
    expect(new Set(LAYER_LINE_TEMPLATE)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(LAYER_CORNER_SLOTS).toBeGreaterThanOrEqual(10);
  });
});
