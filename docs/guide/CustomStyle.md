# Custom style

In the Swift engine, when changing the built-in theme is not enough (see [Style](Style.md)), you write a style of your own: a type that answers, for every feature of every tile, how it draws. The browser port has no counterpart of that today. This page says what the Swift feature is, why the port differs, and how far the theme takes you instead.

## What the Swift engine offers

A Swift map style is two pieces:

- **The schema** (`ImmersiveMapTileSchema`) says what a feature is: a road in a tunnel, a building 30 m tall, a place with names in several languages. It reads the tile's tags, which every tile provider spells its own way.
- **The style** (`ImmersiveMapVectorTileStyle`) says how it looks: colours, widths, labels. It reads the schema's answer, never the tags again.

The app implements either protocol in Swift, and `.mapStyle(VectorTileMapStyle(style:schema:))` hands them to the map.

## Why the browser port differs

The port parses tiles in WebAssembly workers: the schema and the style are Rust code (`crates/map-style`), compiled into the workers' module and checked against the Swift engine on thousands of generated features. A function written in TypeScript cannot run inside that parse without a call across the worker boundary for every feature, which is the cost the port is built to avoid. So:

- `ImmersiveMapVectorTileStyle`, `ImmersiveMapTileSchema`, `VectorTileMapStyle` and the drawing modes (`.polygon`, `.line`, `.pointLockedLine`, `.extrudedPolygon`, `.pointLabel`, `.roadLabel`, `.hidden`) have no TypeScript counterpart.
- `settings.mapStyle(...)` takes the built-in style in a theme, nothing else.
- An archive in another schema than the Protomaps basemap schema does not draw correctly.

## A look of your own from the theme

Most of what a Swift custom style is written for, a palette of your own, is a theme change here. The theme reaches every colour of the ground, the roads, the buildings' features, the trees, the names and the relief shading:

```ts
const grey = (level: number): [number, number, number, number] => [level, level, level, 1];

const settings = ImmersiveMapSettings.default.edit((draft) => {
  const theme = draft.mapStyle.theme;
  theme.layers.land = grey(0.95);
  theme.layers.water = [0.75, 0.8, 0.85, 1];
  for (const cover of ["wood", "grass", "farmland", "sand", "wetland", "park", "residential", "industrial"] as const) {
    theme.layers[cover] = grey(0.93);
  }
  theme.labels.city.fillColor = [0.2, 0.2, 0.2];
  theme.labels.city.strokeColor = [1, 1, 1];
  theme.labels.city.weight = "bold";
});

const map = await ImmersiveMap.create({ container, settings });
```

- **The label text** is not the theme's. The map shows the schema's name in the map's language (`.labelSettings({ language })`), and the theme says only how it looks.
- **The cache.** The map keeps parsed tiles on disk under a fingerprint of everything the parse depends on, the theme included, so a changed theme never shows tiles drawn by the old one. There is no `cacheFingerprint` to keep up to date, as the Swift style has.
- **Beyond the colours**, the theme also holds the road widths by class (`roadMetrics`), the route shields (`routeShields`), which labels show at which zoom (`labelVisibility`), the trees' palette (`layers.trees`), the relief shading (`hillshade`, `terrainOcclusion`) and the label opacity by zoom (`labelOpacity`).

The globe's overview biomes are laid into the tiles of zooms 0 to 7 under the archive's own land cover. `.overviewTiles({ isEnabled: false })` leaves them out:

```ts
ImmersiveMapSettings.default.overviewTiles({ isEnabled: false });
```

The code of this page is in [examples/custom-style.ts](examples/custom-style.ts).
