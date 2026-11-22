# Camera

The camera looks at a point of the map from a zoom, turned by a bearing and tilted by a pitch. Angles are in radians: the bearing clockwise from north, the pitch from straight down.

## Gestures

Out of the box, a user can:

- **Pan.** Drag with one finger, or with the mouse.
- **Zoom.** Pinch, scroll with the mouse wheel, or pinch on a trackpad. A double click or a double tap zooms in one level toward the point.
- **Rotate.** Twist with two fingers. With a mouse, drag sideways with the right button, or with the left button and Alt (Option) held.
- **Tilt.** Drag two fingers up or down. With a mouse, drag up or down with the right button, or with the left button and Alt (Option) held.

On touch screens, the bottom corners hold invisible one-thumb drag zones: the leading corner tilts and the trailing one zooms. They take touch input only. Turn them off where your own controls sit:

```ts
ImmersiveMapSettings.default.cameraControlZones({ pitch: false, zoom: false });
```

The speed and the direction of a tilt drag are set with `.tiltGestureSensitivity(...)`. A negative value tilts the other way.

A wheel or a pinch that starts on an [annotation](AnnotationsAndPins.md) goes to the annotation's element and does not zoom the map.

## The starting position

The `camera` option of `ImmersiveMap.create` sets where the map opens:

```ts
const map = await ImmersiveMap.create({
  container,
  camera: ImmersiveMapCameraPosition.make(48.8584, 2.2945, 16, 0, 1.0),
});
```

`ImmersiveMapCameraPosition.make` takes the latitude, the longitude, the zoom, the bearing and the pitch. The option also takes a view, with the point as longitude and latitude:

```ts
const map = await ImmersiveMap.create({
  container,
  camera: { center: [2.2945, 48.8584], zoom: 16, bearing: 0, pitch: 1.0 },
});
```

`map.view` reads the camera as such a view, and setting `map.view` moves the camera there at once. A map with no `camera` option opens over the centre of Moscow.

### Cities

For a well-known city, `ImmersiveMapCity` holds the coordinates, so the app keeps none:

```ts
const map = await ImmersiveMap.create({ container, camera: { city: "paris" } });
```

The camera stands over the city's centre at zoom 11, where the city shows whole, looking straight down with north up. Set the rest when you need it, in the option (`{ city: "tokyo", zoom: 13, bearing: 0.5, pitch: 1.0 }`) or as a position:

```ts
ImmersiveMapCameraPosition.city("tokyo", 13, 0.5, 1.0);
```

The position works wherever a camera position does, such as `map.camera.fly(ImmersiveMapCameraPosition.city("sydney"))` or a tour's shot. `ImmersiveMapCity.allCases` lists the cities for a picker, with `ImmersiveMapCity.name(city)` the English name and `ImmersiveMapCity.coordinate(city)` the coordinate:

```ts
for (const city of ImmersiveMapCity.allCases) {
  select.append(new Option(ImmersiveMapCity.name(city), city));
}
```

The cities:

- **North America:** `newYork`, `losAngeles`, `sanFrancisco`, `chicago`, `washington`, `boston`, `miami`, `seattle`, `lasVegas`, `toronto`, `vancouver`, `montreal`, `mexicoCity`.
- **South America:** `rioDeJaneiro`, `saoPaulo`, `buenosAires`, `lima`, `bogota`, `santiago`.
- **Europe:** `london`, `paris`, `berlin`, `madrid`, `barcelona`, `rome`, `milan`, `amsterdam`, `vienna`, `prague`, `lisbon`, `athens`, `stockholm`, `copenhagen`, `oslo`, `helsinki`, `dublin`, `brussels`, `zurich`, `munich`, `warsaw`, `budapest`, `istanbul`, `moscow`, `saintPetersburg`, `kyiv`.
- **Africa and the Middle East:** `dubai`, `telAviv`, `cairo`, `capeTown`, `johannesburg`, `nairobi`, `lagos`, `marrakesh`.
- **Asia:** `tokyo`, `osaka`, `seoul`, `beijing`, `shanghai`, `hongKong`, `taipei`, `singapore`, `bangkok`, `kualaLumpur`, `jakarta`, `manila`, `hanoi`, `mumbai`, `delhi`.
- **Oceania:** `sydney`, `melbourne`, `auckland`.

A place that is not in the list takes an `ImmersiveMapCameraPosition` with its own coordinates, as above.

## Moving the camera from code

Every map has a camera controller, `map.camera`. To keep one of your own across maps, pass it as the `cameraController` option. Then:

- **Jump.** `map.camera.jump(position)` moves the camera at once.
- **Fly.** `map.camera.fly(position)` animates there, 1.35 seconds by default. For a long trip, rise over the map first and dive at the target:
  ```ts
  map.camera.fly(position, CameraFlightOptions.make(4, "automatic", "overviewFirst"), (finished) => {
    // false when a gesture or another command interrupted it
    console.log(finished);
  });
  ```
  `CameraFlightOptions.make` takes the duration in seconds, the route (`"automatic"`, `"mercatorShortestPath"` or `"greatCircle"`) and the altitude style (`"direct"` or `"overviewFirst"`).
- **Follow a path.** `map.camera.follow(path, duration)` carries the camera along a path, turned to the direction of travel by default:
  ```ts
  const path = {
    waypoints: [geoCoordinate(48.8584, 2.2945), geoCoordinate(48.8606, 2.3376), geoCoordinate(48.853, 2.3499)],
    baseAltitudeMeters: 0,
    peakAltitudeMeters: 0,
  };
  map.camera.follow(path, 20, "linear");
  ```
  A path is a plain object: two or more waypoints joined by great-circle arcs, and an altitude profile that starts and ends at `baseAltitudeMeters` and crests `peakAltitudeMeters` higher in the middle. The third argument sets the pace. `"easeOut"`, the default, leaves at full speed and settles onto the end, and `"linear"` keeps one speed. The fourth argument sets how the camera frames the point on the way, as `{ zoom, pitch, bearing, smoothingHalfLife }`: a `null` zoom or pitch keeps the camera's own, and the bearing is `{ kind: "course" }` (the default), `{ kind: "unchanged" }` or `{ kind: "fixed", bearing }`. The fifth is called once, with `true` when the path ran out and `false` when something interrupted it. A model can fly the same path with the camera on it (see [3D content](3DContent.md)).
- **Stop.** `map.camera.cancelFlight()` and `map.camera.cancelFollow()`.

The controller also tells you where the camera is: `currentCameraPosition()`, and `onCameraPositionChanged` as it moves. `onUserInteractionBegan` reports that the user took the camera:

```ts
map.camera.onCameraPositionChanged = (current) => console.log(current.zoom);
map.camera.onUserInteractionBegan = () => console.log("the user took the camera");
console.log(map.camera.currentCameraPosition());
```

## Tours

`ImmersiveMapCameraTourController` flies through a list of shots, holding at each one. It stops when the user touches the map:

```ts
const tour = new ImmersiveMapCameraTourController(map.camera);
tour.start(
  [
    ImmersiveMapCameraTourShot.make(eiffelTower, CameraFlightOptions.default, 2),
    ImmersiveMapCameraTourShot.make(louvre, CameraFlightOptions.make(3)),
  ],
  { loop: true },
);
```

`ImmersiveMapCameraTourShot.make` takes the position, the flight there and the seconds to hold after it. The tour flies to the first shot from wherever the camera is. Pass `establish` in the options to jump to a starting position first, `stopOnUserInteraction: false` to keep it running under the user's gestures, and `onFinished` to hear when it ends. `tour.stop()` ends it. The same shots can be recorded into a video (see [Export](Export.md)).

## On-screen buttons

The `cameraControls` option shows buttons and sliders for the bearing and the pitch over the map:

```ts
const map = await ImmersiveMap.create({ container, cameraControls: true });
```

The same panel can be laid over an element of your own, which has to be positioned (not `position: static`):

```ts
const panel = new ImmersiveMapCameraControlPanel({ container: sidebar, camera: map.camera });
```

`settings.controlsHidden()` hides the panel, the control zones and the debug panel at once, for a clean frame.

## Limits

Gestures, commands and flights all keep within these:

```ts
ImmersiveMapSettings.default
  .zoomRange({ minimum: 3, maximum: 18 })
  .pitchRange({ minimum: 0, maximum: 1.2 })
  .bearingLimit(Math.PI / 2); // at most a quarter turn from north
```

A zoomed-out globe turns back to north-up and straight-down on its own. Tune that with `.globeUprightPull({ zoomRange, halfLife })`, or turn it off with `.globeUprightPull(null)`:

```ts
ImmersiveMapSettings.default.globeUprightPull({ zoomRange: { lowerBound: 2, upperBound: 5 }, halfLife: 0.3 });
ImmersiveMapSettings.default.globeUprightPull(null);
```

## Bounds

For a map of one city or one country, keep the camera over it:

```ts
ImmersiveMapSettings.default.cameraBounds({
  southWest: geoCoordinate(55.57, 37.36),
  northEast: geoCoordinate(55.92, 37.86),
});
```

The zoomed-out globe still turns freely. As the camera zooms in, the area it may look at closes in on the region, between zooms 1 and 2 by default, and from there on the camera stays over the region. A flight never lands outside it.

- `pullZoomRange` sets the zooms over which the area closes in. With `{ lowerBound: 3, upperBound: 3 }`, the world is open up to zoom 3 and the region alone past it.
- `pullCurve` sets how it closes across those zooms: `PullCurve.linear`, `PullCurve.easeIn`, `PullCurve.easeOut`, `PullCurve.easeInOut` (the default), or your own `PullCurve.make(x1, y1, x2, y2)`, as in CSS `cubic-bezier()`.
- `edgeBehavior` sets what happens at the edge:
  - `CameraBoundsEdgeBehavior.elastic()`, the default: the camera can be dragged past the edge, up to about 200 points, and is pulled back, harder the farther out it is. Tune it with `CameraBoundsEdgeBehavior.elastic({ maximumStretch, pullHalfLife, pullProgression })`.
  - `CameraBoundsEdgeBehavior.hard`: the edge is a wall for gestures, commands and flights.

```ts
ImmersiveMapSettings.default.cameraBounds({
  southWest: geoCoordinate(55.57, 37.36),
  northEast: geoCoordinate(55.92, 37.86),
  pullZoomRange: { lowerBound: 3, upperBound: 3 },
  pullCurve: PullCurve.make(0.2, 0.8, 0.4, 1),
  edgeBehavior: CameraBoundsEdgeBehavior.elastic({ maximumStretch: 150, pullHalfLife: 0.3 }),
});
```

A region across the antimeridian has a west longitude greater than its east one. `.cameraBounds(null)` opens the whole world again.

The code of this page is in [examples/camera.ts](examples/camera.ts).
