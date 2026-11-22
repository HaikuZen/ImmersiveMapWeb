// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `RenderLayerPlannerTests` and `RenderPassGraphWorldLayerOrderTests`.

import { describe, expect, test } from "vitest";
import { planRenderLayers, type RenderPassAvailability, worldLayerOrder } from "./render-layer.ts";

const base: RenderPassAvailability = {
  renderSurfaceMode: "flat",
  labelsEnabled: true,
  pinsEnabled: true,
  debugOverlayEnabled: false,
  starfieldEnabled: true,
  sceneModelsEnabled: true,
  appLayersEnabled: true,
};

describe("render layers", () => {
  test("the flat world draws the ground, what stands on it, what lies on it, the horizon last", () => {
    const layers = planRenderLayers(base).map((i) => i.layer);
    expect(layers).toEqual(["placementStencil", "flatMapSurface", "buildingExtrusion", "sceneModels", "flatMapRoads", "appLayers", "surfaceLabels", "horizon", "labels", "pins", "debugOverlay"]);
  });

  test("the globe paints the sky first and skips it with transparent space", () => {
    const plan = planRenderLayers({ ...base, renderSurfaceMode: "spherical", starfieldEnabled: false });
    expect(plan[0]).toEqual({ layer: "starfield", enabled: false, skipReason: "transparentSpace" });
    expect(plan.map((i) => i.layer).slice(1, 8)).toEqual(["placementStencil", "globeVectorSurface", "appLayers", "surfaceLabels", "globeCap", "sceneModels", "horizon"]);
  });

  test("layers without content are planned but disabled with their reason", () => {
    const plan = planRenderLayers({ ...base, sceneModelsEnabled: false, appLayersEnabled: false, labelsEnabled: false });
    expect(plan.find((i) => i.layer === "sceneModels")?.skipReason).toBe("noSceneModelContent");
    expect(plan.find((i) => i.layer === "appLayers")?.skipReason).toBe("noAppLayerContent");
    expect(plan.find((i) => i.layer === "labels")?.skipReason).toBe("noLabelContent");
  });

  test("the buildings move before the ground in the drawn order", () => {
    expect(worldLayerOrder(["placementStencil", "flatMapSurface", "buildingExtrusion", "flatMapRoads"])).toEqual([
      "placementStencil",
      "buildingExtrusion",
      "flatMapSurface",
      "flatMapRoads",
    ]);
    expect(worldLayerOrder(["starfield", "globeVectorSurface"])).toEqual(["starfield", "globeVectorSurface"]);
    // On the globe the models stay where the sphere's order puts them.
    expect(worldLayerOrder(["starfield", "placementStencil", "globeVectorSurface", "globeCap", "sceneModels", "horizon"])).toEqual(["starfield", "placementStencil", "globeVectorSurface", "globeCap", "sceneModels", "horizon"]);
  });
});
