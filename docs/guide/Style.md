# Style

The style decides how the map looks: the colours of the land, the water and the roads, the names and their fonts. The built-in style draws the hosted tiles, and you change it by its theme.

## Changing colours

Start from the built-in look and change what you need. The theme is part of the settings' data, `settings.data.mapStyle.theme`, and `edit` hands you a mutable copy of it:

```ts
const map = await ImmersiveMap.create({
  container,
  settings: ImmersiveMapSettings.default.edit((settings) => {
    const theme = settings.mapStyle.theme;
    theme.layers.water = [0.55, 0.75, 0.95, 1];
    theme.layers.park = [0.7, 0.86, 0.62, 1];
    theme.labels.city.sizePoints = 18;
  }),
});
```

This is the counterpart of the Swift `.mapStyle(.default.apply { theme in ... })`. Colours are RGBA from 0 to 1, and the label colours are RGB. The theme has three main parts:

- `layers`: the ground and the lines. `land`, `water`, `wood`, `grass`, `farmland`, `park`, `sand`, `ice`, `wetland`, `residential`, `industrial`, `boundary`, `aeroway`, the `roads`, the globe's `biomes` and `overviewRoads`, and the `trees`.
- `labels`: one appearance per kind of name: `city`, `town`, `district`, `country`, `region`, `poi`, `water` and `road`. Each one has its `fillColor` and `strokeColor` (the halo), `haloEm`, `sizePoints`, `weight`, `letterSpacingEm`, `opacity` and more.
- `hillshade` and `terrainOcclusion`: the shading of the relief (see [Relief](Relief.md)).

`theme.labelOpacity` fades the names in and out by zoom, `names` for every name but the POIs and `pois` for the POIs:

```ts
settings.mapStyle.theme.labelOpacity.pois = zoomCurve({ 14: 0.6, 16: 1 });
```

A change to the colours or the labels parses the tiles again, so set the style once rather than on every frame. The opacity and the relief shading are applied while drawing, and cost nothing to change.

The POI icons are drawn from [Maki](https://github.com/mapbox/maki) icons (CC0), since the SF Symbols the Swift engine draws are not available outside Apple platforms. Their strokes are thinner than the Swift icons' semibold.

## Night

```ts
return map.setSettings((settings) => settings.night(isNight));
```

`.night()` sets the night palette and a night sky, and `.night(false)` brings back the day. For a night of your own, change the night palette with `edit`. The sky is set on its own with `.fogSettings(...)`, here to the night's (`nightFogSettings`, which `.night()` has already set):

```ts
ImmersiveMapSettings.default
  .night()
  .edit((settings) => {
    settings.mapStyle.theme.layers.water = [0.02, 0.04, 0.1, 1];
  })
  .fogSettings(nightFogSettings);
```

## The globe's colours

The zoomed-out globe can wear its own palette, for example a sunlit planet around a dark map. `theme.globeLayers` is the palette of the globe and of its unroll into the plane, `null` for the map's own:

```ts
ImmersiveMapSettings.default.edit((settings) => {
  const theme = settings.mapStyle.theme;
  theme.globeLayers = { ...theme.layers, water: [0.2, 0.4, 0.8, 1] };
});
```

`theme.globeLabels` does the same for the colours of the names.

## Language of the names

Names show in English by default. Choose another language:

```ts
ImmersiveMapSettings.default.labelSettings({ language: LabelLanguage.russian });
```

The language is any code the tiles carry names in: `LabelLanguage.english`, `.russian`, `.french`, `.german`, `.spanish`, `.italian`, `.portuguese`, `.turkish`, or the code itself as a string:

```ts
ImmersiveMapSettings.default.labelSettings({ language: "pl", fallbackPolicy: "localFirst" });
```

The built-in font has Latin and Cyrillic letters only, so a language written in another alphabet, such as Japanese, Chinese, Arabic or Greek, shows the English names. Where a place has no name in that language, the map shows its English name, then its local one. `fallbackPolicy: "localFirst"` shows the local name first.

`.labels({ isEnabled: false })` hides every name.

## Tiles in another schema

The built-in style reads the Protomaps basemap schema. The Swift engine pairs a style of your own with a schema of your own for tiles in another schema. The browser port has no counterpart: the style and the schema run in the tile workers' WebAssembly, and `mapStyle` takes the built-in style alone (see [Custom style](CustomStyle.md)).

The code of this page is in [examples/style.ts](examples/style.ts).
