# Annotations, pins and taps

The map shows three kinds of things you put on it: annotations, pins, and 3D models (see [3D content](3DContent.md)). This page covers the first two, and how to react to taps.

- **Annotations** are live DOM elements, for a few rich things: a callout, a button, the selected place. They take the place of the Swift engine's SwiftUI views.
- **Pins** are pictures the map draws itself on the GPU, for many things: hundreds or thousands of places, photos, icons.

## Annotations

Any element can stand at a coordinate. `map.annotations.set` takes your items and says how to read each one:

```ts
map.annotations.set(places, {
  id: (place) => place.id,
  coordinate: (place) => place.coordinate,
  render: (place) => {
    const label = document.createElement("div");
    label.className = "place-label";
    label.textContent = place.name;
    return label;
  },
  anchor: { x: 0.5, y: 1 },
});
```

The element follows its coordinate on every frame, on the globe and on the flat map, and fades out behind the globe's horizon. `anchor` sets which point of the element stands on the coordinate, in a unit square with the origin in the top left corner, the centre by default. The last item draws on top. Style the elements with your page's own CSS.

An annotation handles its own clicks, with your own listeners. Pointer events outside the annotations go to the map:

```ts
render: (item) => {
  const button = document.createElement("button");
  button.textContent = item.name;
  button.addEventListener("click", () => open(item));
  return button;
},
```

A later `set` replaces the earlier set, and `map.annotations.clear()` removes them all. A wheel or a pinch that starts on an annotation goes to its element and does not zoom the map.

`id` gives each item the key it keeps across calls. An item whose key stays and which is equal to its previous one keeps its element untouched, so adding or removing a few annotations costs only those few. Equal is `Object.is` by default: the same object is the same annotation. Pass `equals: (previous, next) => ...` to compare items of your own, as Swift does for `Equatable` items. The element has to be made from the item alone: state it reads from elsewhere does not reach an annotation whose item did not change.

Use annotations for a few rich elements. Each one is a live element the page moves on every frame, and a map with hundreds of them slows down. For many points, use pins or a [layer](Layers.md).

## Pins

Pins are pictures drawn by the map itself, so many of them stay smooth where DOM elements would not. A pin shows its picture in a frame. Every map has a pins controller, `map.pins`:

```ts
const map = await ImmersiveMap.create({ container, camera: { city: "moscow", zoom: 14 } });
const placeholder = PinImageFactory.number(1, 128);

map.pins.set([
  ImmersiveMapPin.make({
    id: 1,
    coordinate: geoCoordinate(55.75, 37.62),
    image: PinImageSource.remote(photoURL, placeholder),
  }),
  ImmersiveMapPin.make({
    id: 2,
    coordinate: geoCoordinate(55.752, 37.6175),
    image: PinImageFactory.number(2, 128, "rgb(181, 62, 52)"),
    borderColor: [0.7, 0.1, 0.1, 1],
    drawPriority: 1,
  }),
]);
```

- **The picture.** An `ImageBitmap`, an `<img>`, a `<canvas>`, an `OffscreenCanvas`, `ImageData`, an SVG image or a `VideoFrame`. Or `PinImageSource.remote(url, placeholder)`, which the map downloads, showing the placeholder until then. The download is a `fetch` without credentials, so a picture on another origin has to allow the page by CORS. `PinImageFactory.number(value, size, background)` draws a numbered picture, for a quick start or a placeholder.
- **Look.** `borderColor`, `screenSizeScale`, and `drawPriority`, where a higher priority draws on top.
- **Changes.** `add`, `upsert`, `set`, `move(id, coordinate)`, `update(id, { image, borderColor, isSelected })`, `remove(ids)` and `clear()`:
  ```ts
  map.pins.move(3, geoCoordinate(55.756, 37.615));
  map.pins.update(3, { borderColor: [0, 0.4, 0.9, 1], isSelected: true });
  map.pins.remove([1, 2]);
  ```
  The controller lives on the main thread. The Swift controller is thread-safe, which a page has no use for.
- **Groups.** `merge(ids, mergedID)` shows several pins as one, with a counter and their pictures in turn, and `unmerge(mergedID)` splits them again. `clusterPolicy: "event"` on a pin lays a pile of such pins on one place out as a flower.

The size of every pin is set with `settings.pinSettings({ size, sizeScale })`. A change of the pin settings on a running map builds the map's GPU side again.

### The frame

Every pin of a map is drawn in one frame: a shape with an outline, a fill, and the picture cut to the shape. All of it is set in place:

```ts
ImmersiveMapSettings.default.pinSettings({
  shape: PinShape.circle,
  borderWidthPx: 2,
  borderColor: [0, 0, 0, 1],
  fillColor: [1, 1, 1, 1],
  contentInset: 0.04,
});
```

- **`shape`.** `PinShape.bubble` is the map's own rounded square with a tail, the default. `PinShape.circle` and `PinShape.roundedRectangle(cornerRadius, tail)` are the other built-in ones. `PinShape.picture()` draws no frame at all: the pin is its picture, cut by the picture's own alpha.
- **`borderWidthPx` and `borderColor`.** The outline. A width of zero draws none, and a pin's own `borderColor` takes the place of the map's.
- **`fillColor`.** The colour under and around the picture. It shows through a picture's transparent parts.
- **`contentInset`.** How far the picture is set in from the edge, as a part of the pin's size.

A shape of your own is a picture of it: a square PNG drawn in any editor, white where the pin is and transparent or black elsewhere. 256 pixels a side are enough. The Swift engine takes a `CGImage`. Here the shape takes the picture's URL, any URL the page can fetch, a `data:` URL included:

```ts
ImmersiveMapSettings.default.pinSettings({
  shape: PinShape.mask("/images/pin-mask.png", { x: 0.5, y: 1 }, { x: 0, y: 0, width: 1, height: 0.9 }),
});
```

The second argument is the anchor, the point of the shape that stands on the pin's coordinate, and the third is the picture area, the rectangle the pin's picture is laid into. Both are in a unit square, with the origin in the top left corner and y down. The map turns the mask into the frame once, when it is created, so there is no distance texture to prepare.

A shape can also be a path in the same unit square. The Swift engine takes a `CGPath`. Here the path is SVG path data:

```ts
ImmersiveMapSettings.default.pinSettings({
  shape: PinShape.path("M0.5,0 L1,0.5 L0.5,1 L0,0.5 Z", { x: 0.5, y: 1 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }),
});
```

SVG path data does not state its bounding box, so the picture area of a path is the whole square unless you give it, where the Swift engine takes the path's bounding box.

One shape serves all the pins of a map.

### Pins that make room

Pins that would overlap push each other apart. A pin pushed off its place stays tied to it by a beam, like a pin on a rubber band, and comes back when there is room. Turn it off when the exact place matters more than seeing every pin whole:

```ts
ImmersiveMapSettings.default.pinSettings({ spreadsApart: false });
```

Then every pin stands exactly on its coordinate, and pins may cover each other.

## Taps

```ts
map.onPinTap((event) => {
  console.log(`tapped pin ${event.pin.id}`);
});
map.onSceneModelTap((event) => {
  console.log(`tapped model ${event.model.id}`);
});
map.camera.onMapBackgroundTap = () => console.log("tapped the map");
```

A tap is a click with the mouse or a tap on a touch screen. Both listeners hear every tap, also on an object that is already selected, and return the function that stops the listening. A tap on the map itself, away from everything, reaches `onMapBackgroundTap` of the camera controller or of the selection controller.

## Selection

To have the map remember what is selected, attach an `ImmersiveMapSelectionController`, as the `selection` option of `ImmersiveMap.create` or later:

```ts
const selection = new ImmersiveMapSelectionController();
map.selection = selection;
```

A tap selects a pin, a model or a shape of a layer, and a tap on the empty map clears the selection. `onSelectionChanged` and `onSelectionCleared` report it, and `select(selection)` and `clearSelection()` change it from code:

```ts
selection.select({ kind: ImmersiveMapSelectionKind.pin, objectID: 1 });
```

A selection names its object by a `kind` and the object's id: `ImmersiveMapSelectionKind.pin`, `ImmersiveMapSelectionKind.sceneModel`, or `ImmersiveMapSelectionKind.layer("zones")` for a shape of a layer (see [Your own data](Layers.md)). A kind is a string and the kinds are an open set, so a `switch` over one needs a `default`. The events also say what changed the selection, in `source`: `"tap"`, `"programmatic"` or `"system"`.

The code of this page is in [examples/annotations-and-pins.ts](examples/annotations-and-pins.ts).
