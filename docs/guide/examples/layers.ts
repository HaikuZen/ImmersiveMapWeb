// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Layers.md.

import {
  type GeoCoordinate,
  ImmersiveMap,
  ImmersiveMapLayer,
  ImmersiveMapLayersController,
  ImmersiveMapSelectionController,
  ImmersiveMapSelectionKind,
} from "@artembobkin/immersive-map";

/** The app's data registered once, then drawn by two layers. */
export async function districtsAndStops(container: HTMLElement, stops: readonly GeoCoordinate[]): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, camera: { city: "moscow", zoom: 12 } });

  map.layers.register("districts", { geoJSON: new URL("/data/districts.geojson", location.href) });
  map.layers.register("stops", { identity: "v1", points: stops.map((coordinate) => ({ coordinate })) });

  map.layers.set([
    { source: "districts", polygonStyle: { fillColor: [0.9, 0.3, 0.2, 0.3] } },
    { source: "stops", zoomRange: { lowerBound: 12, upperBound: 30 } },
  ]);
  return map;
}

/** A document in memory, known by the identity the app gives it. */
export async function parksFromTheNetwork(map: ImmersiveMap): Promise<void> {
  const response = await fetch("https://data.example.com/parks.geojson");
  const data = await response.text();
  map.layers.register("parks", { geoJSON: data, identity: response.headers.get("ETag") ?? new Date().toISOString() });
}

/** A smaller disk cache of prepared layers, and a larger limit on the data held at one time. */
export async function ownLayersController(container: HTMLElement): Promise<ImmersiveMap> {
  const layers = new ImmersiveMapLayersController({
    cacheLimitBytes: 64 * 1024 * 1024,
    inputLimitBytes: 128 * 1024 * 1024,
  });
  const map = await ImmersiveMap.create({ container, layers });
  return map;
}

/** A source that cannot be read, or does not fit the limit, reported. */
export function failures(map: ImmersiveMap): void {
  map.layers.onSourceFailed = (name, error) => {
    console.error(name, error.kind);
  };
}

/** Shapes built in code, with ids of the app's own and a style of their own. */
export function shapes(map: ImmersiveMap, route: readonly GeoCoordinate[], zone: readonly GeoCoordinate[]): void {
  map.layers.register("plan", {
    identity: "plan-3",
    polygons: [{ id: 1, exterior: zone, style: { fillColor: [0.2, 0.6, 0.3, 0.25] } }],
    polylines: [{ id: 2, coordinates: route }],
    points: [{ id: 3, coordinate: route[0]!, style: { radiusPoints: 8 } }],
  });
}

/** Two layers of one source, at different zooms. */
export function twoLayersOfOneSource(map: ImmersiveMap): void {
  map.layers.set([
    { id: "districts-far", source: "districts", zoomRange: { lowerBound: 0, upperBound: 10 } },
    {
      id: "districts-near",
      source: "districts",
      polygonStyle: { strokeWidthPoints: 4 },
      zoomRange: { lowerBound: 10, upperBound: 30 },
    },
  ]);
}

/** Every style of a layer. */
export const styledLayer: ImmersiveMapLayer = ImmersiveMapLayer.make({
  source: "transit",
  polygonStyle: { fillColor: [0.18, 0.47, 0.96, 0.3], strokeColor: [0.1, 0.3, 0.8, 1], strokeWidthPoints: 2 },
  polylineStyle: { color: [0.85, 0.2, 0.45, 1], widthPoints: 4 },
  pointStyle: { color: [0.95, 0.75, 0.1, 1], radiusPoints: 5, strokeColor: [1, 1, 1, 1], strokeWidthPoints: 2 },
});

/** Showing and hiding. */
export function showingAndHiding(map: ImmersiveMap, showZones: boolean): void {
  map.layers.upsert({
    source: "zones",
    isVisible: showZones,
    zoomRange: { lowerBound: 10, upperBound: 18 },
    hidesBehindTerrain: true,
  });

  map.layers.setVisible("zones", false);
}

/** The controller's changes. */
export function updates(map: ImmersiveMap): void {
  map.layers.upsert({ source: "stops", pointStyle: { radiusPoints: 6 } });
  map.layers.remove("districts-far");
  map.layers.remove(["districts-near", "zones"]);
  console.log(map.layers.layers, map.layers.layer("stops"), map.layers.sourceNames);
  map.layers.clear();
  map.layers.unregister("stops");
}

/** Taps on the shapes, and the selection of one. */
export function tapsAndSelection(map: ImmersiveMap, highlight: (layerID: string, shapeID: number) => void): void {
  map.onLayerTap((event) => {
    console.log(event.layer.id, event.shapeID, event.coordinate);
  });

  const selection = new ImmersiveMapSelectionController();
  selection.onSelectionChanged = (event) => {
    const layerID = ImmersiveMapSelectionKind.layerID(event.selection.kind);
    if (layerID !== null) highlight(layerID, event.selection.objectID);
  };
  map.selection = selection;

  selection.select({ kind: ImmersiveMapSelectionKind.layer("districts"), objectID: 42 });
}
