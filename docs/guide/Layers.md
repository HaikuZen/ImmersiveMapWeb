# Your own data

Layers draw your app's data on the map: zones as polygons, routes as lines, and places as points. They lie on the ground, over the roads and under the names and the buildings, on the globe and on the flat map alike.

It takes two steps. Register the data once, under a name. Then set the layers, which say what to draw of it and how. Every map has a layers controller, `map.layers`:

```ts
const map = await ImmersiveMap.create({ container, camera: { city: "moscow", zoom: 12 } });

map.layers.register("districts", { geoJSON: new URL("/data/districts.geojson", location.href) });
map.layers.register("stops", { identity: "v1", points: stops.map((coordinate) => ({ coordinate })) });

map.layers.set([
  { source: "districts", polygonStyle: { fillColor: [0.9, 0.3, 0.2, 0.3] } },
  { source: "stops", zoomRange: { lowerBound: 12, upperBound: 30 } },
]);
```

The layers draw in the order the controller holds them, so a later one covers an earlier one. The controller takes a layer's options as a plain object, and `ImmersiveMapLayer.make(options)` makes the same layer as a value.

## Sources

A source is data with a name. It is not drawn until a layer names it.

- `register(name, { geoJSON: url })`: a GeoJSON document at a `URL`, fetched when a layer first draws it. It has to be on the page's origin or allowed by CORS.
- `register(name, { geoJSON, identity })`: a GeoJSON document in memory, as text, as UTF-8 bytes or as the parsed object.
- `register(name, { identity, polygons, polylines, points })`: shapes you build in code.
- `unregister(name)` removes a source, and `sourceNames` lists them.

A registered source costs nothing. Its data is read in a worker when a layer first draws it, so you can register every document your app has and draw the few the user picks.

### Identity

The map never looks into your data to tell whether it changed. A document at a URL is known by its URL, and by the `identity` you give it when you know one, such as a version. Without one, the map asks the server for the document's ETag or date. Data in memory is known by the `identity` you give it: a version, a date, an ETag.

```ts
const response = await fetch("https://data.example.com/parks.geojson");
const data = await response.text();
map.layers.register("parks", { geoJSON: data, identity: response.headers.get("ETag") ?? new Date().toISOString() });
```

The same identity means the same data. Registering it again does nothing, and a layer prepared from it earlier is reused. When the data changes, give it another identity, or the map goes on drawing the old data.

A document at a URL may be fetched again later, so it has to stay where it is.

## Fast starts

A layer is prepared for the GPU once and saved in the page's IndexedDB. On the next visit it is loaded from there, straight into the GPU, and its source is not read at all. A changed document, another identity or a changed style is prepared anew.

The saved layers take up to 256 MB of disk, and the ones used least recently are deleted first. Set your own limit, or zero to save nothing, on a controller of your own, which the map takes as its `layers` option:

```ts
const layers = new ImmersiveMapLayersController({
  cacheLimitBytes: 64 * 1024 * 1024,
  inputLimitBytes: 128 * 1024 * 1024,
});
const map = await ImmersiveMap.create({ container, layers });
```

Shapes that change often, such as a live route, get a new saved layer with each identity. Keep such a source small, or lower the limit.

## GeoJSON

A source reads a FeatureCollection, a Feature, a GeometryCollection or a bare geometry. Polygons and MultiPolygons become zones, LineStrings and MultiLineStrings lines, and Points and MultiPoints points.

A feature's own [simplestyle](https://github.com/mapbox/simplestyle-spec) properties (`fill`, `fill-opacity`, `stroke`, `stroke-opacity`, `stroke-width`, `marker-color`, `marker-size`, and `marker-radius` in points) style it, over the styles of the layer that draws it.

A document that cannot be fetched, a document that is not GeoJSON, or a source over the input limit is reported:

```ts
map.layers.onSourceFailed = (name, error) => {
  console.error(name, error.kind);
};
```

`error.kind` is `"unreadableFile"`, `"invalidGeoJSON"` or `"limitExceeded"`.

## Shapes

- A polygon, `{ exterior, holes }`: a zone, its outline and any holes as rings of `GeoCoordinate`.
- A polyline, `{ coordinates }`: a line through the coordinates.
- A point, `{ coordinate }`: a dot.

```ts
map.layers.register("plan", {
  identity: "plan-3",
  polygons: [{ id: 1, exterior: zone, style: { fillColor: [0.2, 0.6, 0.3, 0.25] } }],
  polylines: [{ id: 2, coordinates: route }],
  points: [{ id: 3, coordinate: route[0]!, style: { radiusPoints: 8 } }],
});
```

A `GeoCoordinate` is `{ latitude, longitude }` in degrees, and `geoCoordinate(latitude, longitude)` makes one. Each shape has an `id`, which names it in a tap and in a selection. Pass your own, or leave it out and the shape goes by its place in the source. A GeoJSON feature's shapes take the feature's `id` when it is a whole number, and the feature's place in the document otherwise.

## Layers and styles

A layer draws one source. Its `id` is the source's name unless you give one, which you need when two layers draw the same source:

```ts
map.layers.set([
  { id: "districts-far", source: "districts", zoomRange: { lowerBound: 0, upperBound: 10 } },
  {
    id: "districts-near",
    source: "districts",
    polygonStyle: { strokeWidthPoints: 4 },
    zoomRange: { lowerBound: 10, upperBound: 30 },
  },
]);
```

Each layer has one style per kind of shape, and a shape can carry its own, which wins.

- `polygonStyle: { fillColor, strokeColor, strokeWidthPoints }`: the fill and the outline.
- `polylineStyle: { color, widthPoints }`: a line with round joins and ends.
- `pointStyle: { color, radiusPoints, strokeColor, strokeWidthPoints }`: a disc with a ring around it.

```ts
ImmersiveMapLayer.make({
  source: "transit",
  polygonStyle: { fillColor: [0.18, 0.47, 0.96, 0.3], strokeColor: [0.1, 0.3, 0.8, 1], strokeWidthPoints: 2 },
  polylineStyle: { color: [0.85, 0.2, 0.45, 1], widthPoints: 4 },
  pointStyle: { color: [0.95, 0.75, 0.1, 1], radiusPoints: 5, strokeColor: [1, 1, 1, 1], strokeWidthPoints: 2 },
});
```

Colours are RGBA from 0 to 1. Widths and radii are in CSS pixels, so they stay the same size at every zoom. A zero alpha or a zero width leaves that part out.

Lines and outlines are always solid. A fill and a point can be translucent, but for a line the alpha only says whether it draws: zero leaves it out, and anything else draws it opaque. A GeoJSON feature's `stroke-opacity` is treated the same way.

A line's edge is not softened, which lets the map draw even hundreds of thousands of segments cheaply. For smooth edges, turn on `.msaa()`.

## Showing and hiding

```ts
map.layers.upsert({
  source: "zones",
  isVisible: showZones,
  zoomRange: { lowerBound: 10, upperBound: 18 },
  hidesBehindTerrain: true,
});

map.layers.setVisible("zones", false);
```

- `isVisible`: `map.layers.setVisible(id, false)` hides a layer the controller holds. A hidden layer keeps what was prepared of it while memory allows, so showing it again is immediate.
- `zoomRange`: the camera zooms the layer draws at.
- `hidesBehindTerrain`: lets a mountain in front of the layer cover it. Off by default, so a layer shows over the relief everywhere.

## Updates

Change the layers through the controller:

- `set(layers)` replaces every layer, and a layer left out is let go.
- `upsert(layer)` or `upsert(layers)` puts a layer in the place of the one with its id, or adds it after the last one.
- `remove(id)`, `remove(ids)` and `clear()` take layers away.
- `layers` and `layer(id)` read what the controller holds.

A layer is a small value, so setting the same layers again costs nothing. The map prepares a changed layer in a worker and goes on drawing the old one until the new one is ready. To change the data, register the new data under the same name, with another identity.

The controller lives on the main thread, like the rest of the map's API. The Swift controller is thread-safe, which a page has no use for.

## Memory

The map reads a source's data to prepare a layer, and lets it go once the layer is prepared. A map that listens to taps on its layers, with `map.onLayerTap` or a selection controller, keeps the data of the layers it draws, since a tap is tested against it.

The data held at one time is bounded by one limit, 64 MB by default: 16 bytes for a coordinate and a small fixed cost for a shape. Set it with `inputLimitBytes`, as in the controller above.

If the sources needed at once do not fit, the one drawn last in the layers' order is refused, and `onSourceFailed` reports `"limitExceeded"`. It is read again when another source is no longer needed.

The Swift engine lets go of the prepared layers that are not drawn when the system warns of low memory. Browsers send pages no such warning, so the port has no counterpart.

## Taps and selection

```ts
map.onLayerTap((event) => {
  console.log(event.layer.id, event.shapeID, event.coordinate);
});
```

A tap lands on the shape the map shows under it: of the layer drawn last first, and within a layer its points, then its lines, then its zones. A zone is hit in its fill, or on its outline when it has no fill. A thin line and a small point grow to a touch target. A pin or a model over a shape takes the tap first.

With an `ImmersiveMapSelectionController` (see [Annotations, pins and taps](AnnotationsAndPins.md)), a tap also selects the shape:

```ts
const selection = new ImmersiveMapSelectionController();
selection.onSelectionChanged = (event) => {
  const layerID = ImmersiveMapSelectionKind.layerID(event.selection.kind);
  if (layerID !== null) highlight(layerID, event.selection.objectID);
};
map.selection = selection;

selection.select({ kind: ImmersiveMapSelectionKind.layer("districts"), objectID: 42 });
```

A selected shape looks the same as before. To highlight it, draw it yourself: register the shape as a source of its own and add a layer over it.

The code of this page is in [examples/layers.ts](examples/layers.ts).
