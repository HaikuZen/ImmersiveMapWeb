# The scene

Beyond the map's own colours (see [Style](Style.md)), the scene around it has a look of its own: the globe and space, the sun and the shadows, the sky and the fog, the buildings and the trees. Everything here is on by default, and each settings method sets only the values you pass, leaving the others as they are.

```ts
const settings = ImmersiveMapSettings.default
  .sceneLight({ direction: [-0.5, -0.4, 0.8] }) // towards the sun: x east, y north, z up
  .shadows({ strength: 0.6, softness: 1.5 })
  .groundFog({ startDistanceMeters: { 12: 3000, 16: 400 } })
  .buildingExtrusion({ buildingsMinimumZoom: 15, risesFromTheGround: false })
  .trees({ minimumZoom: 15, maximumPerTile: 2000 });

const map = await ImmersiveMap.create({ container, settings, camera: { city: "london", zoom: 16, pitch: 1.0 } });
```

## Globe and space

```ts
ImmersiveMapSettings.default
  .globe({ isEnabled: false }) // a flat map at every zoom
  .atmosphere({ isEnabled: false }) // no glow around the globe
  .transparentSpace(); // the page's own background around the globe
```

The zoomed-out map is a globe in space, which unrolls into the flat map as you zoom in. `.transparentSpace()` draws no space and no stars, and leaves the canvas transparent there, so the page's own background shows around the planet.

The globe is lit by a sun, with a night side. `.globeLight({ subsolarLatitudeDegrees, subsolarLongitudeDegrees, strength, nightColor })` moves the sun and tunes the night, and `.globeLight({ isEnabled: false })` lights the globe evenly:

```ts
ImmersiveMapSettings.default.globeLight({
  subsolarLatitudeDegrees: 10,
  subsolarLongitudeDegrees: 30,
  strength: { 2: 0.8, 6: 0.2 },
  nightColor: [0.02, 0.03, 0.08],
});
```

## Sun and shadows

On the flat map, buildings, trees and models cast shadows from a fixed sun, set with `.sceneLight({ direction })` and `.shadows({ strength, softness })` as in the example above. `.shadows({ isEnabled: false })` turns them off. The shadows' other values, such as how far from the camera they reach, are on the same method, and the ones that change with the zoom take a curve:

```ts
ImmersiveMapSettings.default.shadows({ nearCoverageMeters: { 14: 4000, 18: 300 } });
```

## Sky and fog

The flat map has a sky above its horizon, and a fog that rises from the ground and veils the far distance:

```ts
ImmersiveMapSettings.default
  .fog({ isEnabled: false }) // no sky gradient
  .groundFog({ isEnabled: false }); // no ground fog
```

The ground fog is tuned with `.groundFog({ densityPerKilometer, heightMeters, startDistanceMeters, ... })`. Most of its values are curves over the zoom, written as `{ 12: 3000, 16: 400 }`, so the fog changes smoothly as you zoom:

```ts
ImmersiveMapSettings.default.groundFog({
  heightMeters: 120,
  startDistanceMeters: { 12: 3000, 16: 400 },
  startSoftnessMeters: { 12: 20_000, 16: 800 },
  maximumOpacity: { 18: 1, 19: 0 },
});
```

With the relief on, `.mountainGroundFog(...)` gives the mountains an air of their own, with the same values (see [Relief](Relief.md)).

## Buildings and trees

`.buildingExtrusion(...)` and `.trees(...)` in the example above set when the buildings stand up and where the trees grow.

- **Buildings** stand up from zoom 14 by default, growing out of the ground in 0.6 seconds when they appear. `risesFromTheGround: false` shows them at once.
- **Trees** stand on woods and parks from zoom 14. `.trees({ isEnabled: false })` removes them, and `maximumPerTile` limits how many draw, for a lighter frame.

A change to either on a running map builds the map's GPU side again, where the Swift engine applies it in place, so set them once.

## Smoother edges

The map's lines are smooth already. For smoother building and model edges, at some cost in speed:

```ts
ImmersiveMapSettings.default.msaa(); // 4 samples a pixel, the cleaner of the two
ImmersiveMapSettings.default.fxaa(); // one cheap pass over the finished frame
```

The code of this page is in [examples/scene.ts](examples/scene.ts).
