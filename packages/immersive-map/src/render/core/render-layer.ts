// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The layers of a frame and their passes, a port of the Swift `RenderLayer`,
 * `RenderLayerPlanner` and the order rules of `RenderPassGraph`.
 */

export type RenderLayer =
  | "shadowCasters"
  | "farShadowCasters"
  | "groundShadowMask"
  | "starfield"
  | "globeVectorSurface"
  | "globeCap"
  | "placementStencil"
  | "flatMapSurface"
  | "flatMapRoads"
  | "appLayers"
  | "surfaceLabels"
  | "buildingExtrusion"
  | "sceneModels"
  | "horizon"
  | "postProcessing"
  | "labels"
  | "pins"
  | "debugOverlay";

export type RenderPassName = "shadowMap" | "farShadowMap" | "groundShadowMask" | "world" | "postProcessing" | "overlay";

export type RenderSkipReason = "transparentSpace" | "noSceneModelContent" | "noAppLayerContent" | "noLabelContent" | "noPinContent" | "debugOverlayDisabled";

export interface RenderPassAvailability {
  renderSurfaceMode: "flat" | "spherical";
  labelsEnabled: boolean;
  pinsEnabled: boolean;
  debugOverlayEnabled: boolean;
  /** False when space is configured transparent: no space background and no stars. */
  starfieldEnabled: boolean;
  sceneModelsEnabled: boolean;
  appLayersEnabled: boolean;
}

export interface RenderLayerPlanItem {
  layer: RenderLayer;
  enabled: boolean;
  skipReason: RenderSkipReason | undefined;
}

const WORLD_LAYERS: ReadonlySet<RenderLayer> = new Set([
  "starfield",
  "globeVectorSurface",
  "globeCap",
  "placementStencil",
  "flatMapSurface",
  "flatMapRoads",
  "appLayers",
  "surfaceLabels",
  "buildingExtrusion",
  "sceneModels",
  "horizon",
]);

const OVERLAY_LAYERS: ReadonlySet<RenderLayer> = new Set(["labels", "pins", "debugOverlay"]);

export const isWorldLayer = (layer: RenderLayer) => WORLD_LAYERS.has(layer);
export const isOverlayLayer = (layer: RenderLayer) => OVERLAY_LAYERS.has(layer);

/** The frame's layers, the world first in its surface's order, then the overlay. */
export function planRenderLayers(a: RenderPassAvailability): RenderLayerPlanItem[] {
  const world: RenderLayer[] =
    a.renderSurfaceMode === "flat"
      ? // The ground, what stands on it, what lies on it, the horizon last.
        ["placementStencil", "flatMapSurface", "buildingExtrusion", "sceneModels", "flatMapRoads", "appLayers", "surfaceLabels", "horizon"]
      : // Sky first, the tile geometry blends over it, the horizon last.
        ["starfield", "placementStencil", "globeVectorSurface", "appLayers", "surfaceLabels", "globeCap", "sceneModels", "horizon"];
  const items: RenderLayerPlanItem[] = world.map((layer) => {
    if (layer === "starfield" && !a.starfieldEnabled) return { layer, enabled: false, skipReason: "transparentSpace" };
    if (layer === "sceneModels" && !a.sceneModelsEnabled) return { layer, enabled: false, skipReason: "noSceneModelContent" };
    if (layer === "appLayers" && !a.appLayersEnabled) return { layer, enabled: false, skipReason: "noAppLayerContent" };
    return { layer, enabled: true, skipReason: undefined };
  });
  items.push(
    { layer: "labels", enabled: a.labelsEnabled, skipReason: a.labelsEnabled ? undefined : "noLabelContent" },
    { layer: "pins", enabled: a.pinsEnabled, skipReason: a.pinsEnabled ? undefined : "noPinContent" },
    { layer: "debugOverlay", enabled: a.debugOverlayEnabled, skipReason: a.debugOverlayEnabled ? undefined : "debugOverlayDisabled" },
  );
  return items;
}

/**
 * The world pass's drawn order: the opaque buildings move before the ground,
 * so every ground fragment under a building fails its depth test unshaded
 * (the ground writes only its rank band, farther than any building).
 */
export function worldLayerOrder(layers: readonly RenderLayer[]): RenderLayer[] {
  const surface = layers.indexOf("flatMapSurface");
  const building = layers.indexOf("buildingExtrusion");
  if (surface < 0 || building < 0 || surface > building) return [...layers];
  const ordered = [...layers];
  ordered.splice(building, 1);
  ordered.splice(surface, 0, "buildingExtrusion");
  return ordered;
}

/**
 * Tile units per device pixel for the dash pattern of a tile of world size
 * `sourceTileWorldSize`: fixed per draw at the tile's nominal scale, so the
 * dashes stay glued to the map (the Swift `LineDashNominalScale`).
 */
export function lineDashUnitsPerPixel(sourceTileWorldSize: number, drawableHeightPx: number): number {
  if (sourceTileWorldSize <= 0 || drawableHeightPx <= 0) return 0;
  return (4096 * 2 * Math.tan(Math.PI / 8)) / (drawableHeightPx * sourceTileWorldSize);
}
