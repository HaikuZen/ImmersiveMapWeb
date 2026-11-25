// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMap } from "@artembobkin/immersive-map";

/**
 * The e2e app's `layers=1`: a sample of the app's own data over central
 * Moscow (public/layers/moscow.geojson, served with the page): zones with
 * their own simplestyle colours, two lines and a few stations, drawn by two
 * layers of the one source, the zones and the stations in one, the lines
 * wider in the other. A tap on a shape is counted in `window.layerTaps`.
 */
export function addSampleLayers(map: ImmersiveMap): void {
  map.layers.register("moscow", { geoJSON: new URL("/layers/moscow.geojson", location.href) });
  map.layers.onSourceFailed = (name, error) => console.error(`the layer source ${name} failed: ${JSON.stringify(error)}`);
  map.layers.set([
    {
      id: "moscow-zones",
      source: "moscow",
      polygonStyle: { fillColor: [0.18, 0.47, 0.96, 0.3], strokeColor: [0.1, 0.3, 0.8, 1], strokeWidthPoints: 2 },
      polylineStyle: { color: [0, 0, 0, 0] },
      pointStyle: { color: [0.95, 0.75, 0.1, 1], radiusPoints: 5, strokeColor: [1, 1, 1, 1], strokeWidthPoints: 2 },
    },
    {
      id: "moscow-lines",
      source: "moscow",
      polygonStyle: { fillColor: [0, 0, 0, 0], strokeColor: [0, 0, 0, 0] },
      polylineStyle: { color: [0.85, 0.2, 0.45, 1], widthPoints: 4 },
      pointStyle: { color: [0, 0, 0, 0], strokeColor: [0, 0, 0, 0] },
      zoomRange: { lowerBound: 10, upperBound: 30 },
    },
  ]);
  const taps: { layer: string; shape: number }[] = [];
  map.onLayerTap((event) => taps.push({ layer: event.layer.id, shape: event.shapeID }));
  Object.assign(window, { layerTaps: taps });
}
