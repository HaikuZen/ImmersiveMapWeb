// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMap, ImmersiveMapSceneModel, ImmersiveMapSelectionController } from "@artembobkin/immersive-map";

/** The playground's `models=1`: the app's own 3D models near the default view (the centre of Moscow), from the playground's own files, so nothing leaves the machine. */
const centre = { latitude: 55.752, longitude: 37.6175 };

/**
 * Stands two copies of the sample glTF tower (apps/playground/public/models/test-tower.gltf)
 * sized to 120 m, one turned and one sunk into the ground with its ground
 * cut, and the Spot model (OBJ) beside them. A selection controller makes a
 * tap select a model, and the taps and selections are counted on
 * `window.sampleSceneModelEvents` for the smoke test.
 */
export function addSampleSceneModels(map: ImmersiveMap): void {
  map.sceneModels.set([
    ImmersiveMapSceneModel.make({ id: 1, source: "/models/test-tower.gltf", coordinate: centre, headingDegrees: 30, fitDiameterMeters: 120 }),
    ImmersiveMapSceneModel.make({
      id: 2,
      source: "/models/test-tower.gltf",
      coordinate: { latitude: centre.latitude + 0.0015, longitude: centre.longitude + 0.003 },
      altitudeMeters: -30,
      fitDiameterMeters: 120,
      cutsIntoGround: true,
    }),
    ImmersiveMapSceneModel.make({ id: 3, source: "/models/spot.obj", coordinate: { latitude: centre.latitude - 0.0012, longitude: centre.longitude - 0.002 }, headingDegrees: 210, fitDiameterMeters: 90 }),
  ]);
  const events = { taps: 0, selections: 0, lastTapped: -1 };
  const selection = new ImmersiveMapSelectionController();
  selection.onSelectionChanged = () => {
    events.selections += 1;
  };
  map.selection = selection;
  map.onSceneModelTap((event) => {
    events.taps += 1;
    events.lastTapped = event.model.id;
  });
  Object.assign(window, { sampleSceneModelEvents: events });
}
