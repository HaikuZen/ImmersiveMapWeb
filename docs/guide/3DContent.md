# 3D content

The map can show two kinds of 3D models: detailed buildings from a model archive, which replace the map's own boxes, and your own models placed anywhere.

## Building models

The map raises every building from its footprint. A model archive replaces some of them with detailed models, such as the Kremlin or a skyscraper. Unlike the Swift engine, the web map shows no building models by default: the hosted Kremlin tile alone holds more than a million triangles and takes the frame past its GPU budget at zoom 14. To show the hosted models, name their archive:

```ts
ImmersiveMapSettings.default.modelArchive(ImmersiveMapTilesService.modelArchiveURL);
```

Without models, which is the default, the archive is null:

```ts
ImmersiveMapSettings.default.modelArchive(null);
```

To show your own models, point the map at your archive:

```ts
ImmersiveMapSettings.default.modelArchive("https://tiles.example.com/models.pmtiles");
```

The archive is a PMTiles file read like the [tile source](TileSource.md): over HTTP range requests, with request headers as the second argument for credentials, and by CORS from another origin. The models of the area in view load in a worker of their own as the camera moves, and are kept on disk in the page's IndexedDB. A building stays drawn until its model has loaded, so the map never shows a gap.

How they load and draw:

```ts
ImmersiveMapSettings.default.modelArchiveSettings({
  memoryBudgetInBytes: 300_000_000,
  depthBias: { 14: 0.05, 15.5: 0.01 },
  minimumZoom: 14,
});
```

- `memoryBudgetInBytes` and `diskCacheSizeInBytes`: how much of the models stays in GPU memory and on disk.
- `depthBias`: draws a model slightly nearer than it stands, so it covers the plain building it replaces.
- `minimumZoom`: the camera zoom the models appear at.

## Your own models

Place glTF 2.0, GLB or OBJ models at coordinates with the scene models controller, `map.sceneModels`:

```ts
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
```

- **The file.** The Swift engine reads USDZ or OBJ files from the app's bundle or disk, through Model I/O. The browser port reads glTF 2.0 (`.gltf` with its buffers and images), GLB and OBJ (with its `mtllib` and textures), from a URL it fetches: the page's own origin, or a server that allows the page by CORS. A relative URL is resolved against the page. A USDZ file has to be converted to glTF first. The format is read from the URL's extension. For a `blob:` URL or a URL without one, name it: `ImmersiveMapSceneModelSource.make(url, "glb")`. Models that share a source share one loaded mesh.
- **Size.** One unit of the file is one metre, with +Y up. `scale` multiplies it, and `fitDiameterMeters` resizes the model so its largest side spans that many metres.
- **Placement.** `altitudeMeters` above the ground, `headingDegrees` clockwise from north, and `pitchDegrees` and `rollDegrees`. `cutsIntoGround: true` hides the part of a model sunk below the ground everywhere but inside its own outline, for a pit or a half-buried hall.
- **Changes.** `setOrientation(id, { headingDegrees, pitchDegrees, rollDegrees })`, `setScale(id, scale)` and `setAltitude(id, meters)` animate over the duration given as their last argument, 0.3 seconds by default. `move(id, coordinate)` moves along the great circle, over a duration the map derives from the distance, where the Swift method takes one. `add`, `upsert`, `remove(ids)` and `clear()` change the set.

```ts
map.sceneModels.move(1, geoCoordinate(48.8606, 2.3376));
map.sceneModels.setOrientation(1, { headingDegrees: 180, pitchDegrees: 10 });
map.sceneModels.setScale(1, 2, 1.0);
map.sceneModels.setAltitude(1, 200);
```

The models are parsed on the main thread, so a large OBJ file can hold up a frame while it loads.

### Flying along a path

```ts
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
```

The model turns to its direction of travel, unless the options say `appliesHeading: false`, and pitches with the climb unless they say `appliesPitch: false`. To have the camera fly with it, start `map.camera.follow(path, duration, curve)` (see [Camera](Camera.md)) with the same path, duration and curve. `map.sceneModels.cancelPathAnimation(id)` stops the flight where it got to.

Taps on models arrive in `map.onSceneModelTap` (see [Annotations, pins and taps](AnnotationsAndPins.md)).

The code of this page is in [examples/3d-content.ts](examples/3d-content.ts).
