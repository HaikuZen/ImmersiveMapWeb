// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/3DContent.md.

import { geoCoordinate, ImmersiveMap, ImmersiveMapSceneModel, ImmersiveMapSceneModelSource, ImmersiveMapSettings, ImmersiveMapTilesService } from "@artembobkin/immersive-map";

/** The hosted archive of building models: off by default, named to show them. */
export const hostedModels: ImmersiveMapSettings = ImmersiveMapSettings.default.modelArchive(ImmersiveMapTilesService.modelArchiveURL);

/** No building models, the default. */
export const noModels: ImmersiveMapSettings = ImmersiveMapSettings.default.modelArchive(null);

/** An archive of the app's own models. */
export const ownModels: ImmersiveMapSettings = ImmersiveMapSettings.default.modelArchive("https://tiles.example.com/models.pmtiles");

/** How the building models load and draw. */
export const modelLoading: ImmersiveMapSettings = ImmersiveMapSettings.default.modelArchiveSettings({
  memoryBudgetInBytes: 300_000_000,
  depthBias: { 14: 0.05, 15.5: 0.01 },
  minimumZoom: 14,
});

/** A model of the app's own by the Eiffel Tower. */
export async function balloon(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, camera: { center: [2.2945, 48.8584], zoom: 16, pitch: 1.0 } });

  map.sceneModels.set([
    ImmersiveMapSceneModel.make({
      id: 1,
      source: "/models/balloon.glb",
      coordinate: geoCoordinate(48.8584, 2.2945),
      altitudeMeters: 120,
      headingDegrees: 90,
      fitDiameterMeters: 40,
    }),
  ]);
  return map;
}

/** A source whose URL names no format. */
export const blobSource: ImmersiveMapSceneModelSource = ImmersiveMapSceneModelSource.make("blob:https://app.example/5f0c", "glb");

/** A model sunk into the ground, with its ground cut. */
export const sunkenModel: ImmersiveMapSceneModel = ImmersiveMapSceneModel.make({
  id: 2,
  source: "/models/hall.gltf",
  coordinate: geoCoordinate(48.8606, 2.3376),
  altitudeMeters: -30,
  fitDiameterMeters: 120,
  cutsIntoGround: true,
});

/** The animated changes of a model. */
export function changes(map: ImmersiveMap): void {
  map.sceneModels.move(1, geoCoordinate(48.8606, 2.3376));
  map.sceneModels.setOrientation(1, { headingDegrees: 180, pitchDegrees: 10 });
  map.sceneModels.setScale(1, 2, 1.0);
  map.sceneModels.setAltitude(1, 200);
  map.sceneModels.remove(2);
}

/** A model flying along a path, with the camera on it. */
export function flyAlong(map: ImmersiveMap): void {
  const path = {
    waypoints: [geoCoordinate(48.8584, 2.2945), geoCoordinate(48.853, 2.3499)],
    baseAltitudeMeters: 0,
    peakAltitudeMeters: 300,
  };

  map.sceneModels.animate(1, path, 20, { curve: "linear" }, (finished) => {
    // false when it was interrupted
    console.log(finished);
  });
  map.camera.follow(path, 20, "linear");
}
