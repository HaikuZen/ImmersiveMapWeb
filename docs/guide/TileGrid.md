# The tile grid

The tile grid draws the borders of the XYZ tiles over the map, with each tile's numbers written inside it, and lets your user pick tiles by a tap. It is for an app that works by tiles: one that downloads map regions, orders imagery, or shows what a tile server holds.

The grid names squares of the ground, not the tiles the map loads. It shows the tiles of any zoom, whatever zooms your archive holds, on the globe and on the flat map alike. It is drawn over everything the map draws, the buildings and the names included, and under the pins.

A map shows the grid while a controller is attached to it:

```ts
const grid = new ImmersiveMapTileGridController();
grid.onSelectionChanged = (change) => {
  console.log(change.added, change.removed, change.selectedTiles.length);
};

const map = await ImmersiveMap.create({ container, camera: { city: "moscow", zoom: 13 }, tileGrid: grid });
map.setSettings((settings) => settings.tileGridSettings({ zoomRange: [15, 15] }));
```

A tap on a tile selects it, a second tap deselects it, and any number of tiles can be selected at once. The controller holds the selected tiles and reports every change.

Attach a controller to a running map, or take the grid away with `null`:

```ts
map.tileGrid = grid;
map.tileGrid = null;
```

## Which tiles show

The grid shows the tiles of the camera's zoom, clamped into `zoomRange`. `[12, 15]` follows the camera between those zooms, stays at 12 when the camera is higher and at 15 when it is lower. `[15, 15]` shows the zoom 15 tiles alone at any camera zoom. Every zoom is shown by default.

```ts
map.setSettings((settings) =>
  settings.tileGridSettings({
    zoomRange: [12, 15],
    lineColor: [0.9, 0.2, 0.2, 0.8],
    lineWidthPoints: 2,
    selectedFillColor: [0.9, 0.2, 0.2, 0.3],
    labelFormat: "xyz",
  }),
);
```

- `minimumTileScreenPoints`: the grid hides while a tile is narrower on screen than this, so a deep zoom seen from far above is not a mesh of lines. Under a tilted camera the far tiles fade by the same width. 48 by default.
- `labelMinimumTileScreenPoints`: the texts hide while a tile is narrower than this. 96 by default.
- `maximumDrawnTiles`: the most tiles drawn in a frame, the nearest to where the camera looks first. It bounds a frame's work under a camera tilted to the horizon. 512 by default.
- `lineColor`, `lineWidthPoints`, `selectedFillColor`, `labelColor`, `labelHaloColor`, `labelHaloWidthPoints`: the look. A border is as wide in points at every zoom.
- `labelFormat`: `"zxy"` writes `zoom/x/y`, the order of a tile URL, `"xyz"` writes `x/y/zoom`, and `"hidden"` writes nothing.
- `labelMaximumWidthShare`, `labelMaximumHeightShare`: the text is sized to its tile, within these shares of the tile's width and height, so it grows and shrinks with the tile.

Every setting of the grid applies live, with no rebuild of the map.

## The selection

Read the selection at any time and change it from code:

```ts
const tile = ImmersiveMapTileID.containing({ latitude: 55.7539, longitude: 37.6208 }, 15);
grid.select(tile);
grid.select(ImmersiveMapTileID.children(tile));
grid.toggle(ImmersiveMapTileID.make(15, 19807, 10243));
grid.deselect(tile);
console.log(grid.isSelected(tile), grid.selectedTiles.map(ImmersiveMapTileID.key));
grid.setSelectedTiles([tile]);
grid.clearSelection();
```

`onSelectionChanged` is called after every change, by a tap or from code, with the tiles added, the tiles removed, every selected tile, and `source`: `"tap"` for the user and `"programmatic"` for your own call. A call that changes nothing reports nothing.

The selected tiles may be of any zoom. The selected tiles of the zoom the grid shows are filled inside their borders. The selected tiles of other zooms are drawn as their fill alone, so a selection made at zoom 15 still shows when the grid moves to zoom 14.

A tile is plain data, `{ zoom, x, y }`, and `ImmersiveMapTileID` has what you need of it:

```ts
const tile = ImmersiveMapTileID.make(15, 19808, 10243);
const bounds = ImmersiveMapTileID.bounds(tile);
const center = ImmersiveMapTileID.center(tile);
const parent = ImmersiveMapTileID.parent(tile);
const url = `https://tiles.example.com/${ImmersiveMapTileID.key(tile)}.png`;
```

`make` holds the numbers to the map: the zoom to 0 through 24, the x wrapped round the antimeridian, the y clamped. Two tiles are the same tile when their three numbers are (`ImmersiveMapTileID.equals`), and `key` gives a string for a `Map` or a `Set`.

## The gesture

By default a tile is selected by a tap, or a click of the main button. The map also zooms in on a double tap, so a single tap waits about a third of a second to learn that no second tap follows, and two quick taps on one tile are a zoom and not two taps. Where a tap must act at once, turn the double tap zoom off:

```ts
map.setSettings((settings) => settings.doubleTapZoom(false));
```

The first tap then selects a tile immediately and the next one deselects it. The map still zooms by the pinch, the wheel and the zoom control.

Or select by another gesture, and hold one tile at a time:

```ts
map.setSettings((settings) => settings.tileGridSettings({ selectionGesture: "doubleTap", selectionMode: "single" }));
```

- `selectionGesture: "tap"`: a tap, a click of the main button.
- `selectionGesture: "doubleTap"`: a double tap, a double click. While the grid takes it, the double tap does not zoom the map, and a single tap stays what it is for the pins and the rest of the map.
- `selectionGesture: "secondaryTap"`: a click of the right button, a long press on a touch screen. A drag of the right button still tilts the camera.
- `selectionMode: "multiple"`: the gesture adds a tile to the selection or takes a selected one out. The default.
- `selectionMode: "single"`: the gesture on another tile moves the selection to it, and on the selected tile takes the selection away.

A mouse press is a click while the cursor stays within 4 points of where it went down, and a drag of the map past that. `settings.tapMovementTolerance(points)` changes it.

## Limits

Cap how many tiles the taps may select, and where:

```ts
const city = ImmersiveMapGeoBounds.make({ latitude: 55.55, longitude: 37.35 }, { latitude: 55.92, longitude: 37.85 });
map.setSettings((settings) => settings.tileGridSelection({ limit: 20, selectableBounds: city }));

grid.onTapRejected = (rejection) => {
  if (rejection.reason.kind === "limitReached") console.log(`no more than ${rejection.reason.limit} tiles`);
  else console.log(`${ImmersiveMapTileID.key(rejection.tile)} is outside the city`);
};
```

A tile is selectable when it shares an area with the box. A tap past the limit or outside the area selects nothing and is reported to `onTapRejected`, with the tile, the reason, the coordinate and the point of the screen. Both values are set as given: `null` means no limit, and the whole map.

A selected tile can always be deselected, whatever the rules. A selection made from code is your own and is held to neither rule.

To show the grid and a selection without letting the user change it:

```ts
map.setSettings((settings) => settings.tileGridSettings({ isTapSelectionEnabled: false }));
```

## Your own texts

Write your own text inside each tile, in place of its numbers: a name, a count, a status.

```ts
grid.labelProvider = (tile) => {
  const count = counts.get(ImmersiveMapTileID.key(tile));
  return count === undefined ? null : `${count} orders`;
};
// The counts changed: the tiles in view are asked again.
grid.reloadLabels();
```

The provider is called for the tiles in view, once for each, and the answer is kept until you call `reloadLabels()`. `null` or an empty text leaves a tile without text. The text is one line, of the characters the map's labels are written with: a character the font lacks is left out.

For the borders alone:

```ts
map.setSettings((settings) => settings.tileGridSettings({ labelFormat: "hidden" }));
```

## The grid and the map's selection

The selected tiles are a set of the controller's own, apart from the map's single selection (`map.selection`, see [Annotations, pins and taps](AnnotationsAndPins.md)). The grid lies under everything else, so a pin, a model or a shape of a layer under the tap takes it first. A tap on a tile never becomes the map's selection. It ends it, as a tap on the bare map does, and the background tap callbacks do not fire for it.

A tap outside `selectableBounds` is not the grid's: it goes on as a tap on the bare map.

## Differences from the Swift engine

- The controller is attached with the `tileGrid` option or `map.tileGrid`, in place of the `tileGrid(_:)` modifier, and the settings are `settings.tileGridSettings({...})` and `settings.tileGridSelection({...})`.
- A tile is plain data with the functions of `ImmersiveMapTileID` beside it, and `selectedTiles` is an array: JavaScript's `Set` holds objects by identity, not by value.
- Everything runs on the main thread, so the controller has no thread safety to speak of.
- A tile that is not selected is drawn as the band of its border and not as a whole tile, which costs the GPU less for the same picture ([B23](../benchmarks/B23-tile-grid.md)).
- A picture and a video of the map (`captureStill`, the tour video) show no grid, as in the Swift engine.
