# Attribution

The licenses of map data ask for a credit on or next to the map. The map shows it as a badge: one line of credits along its edge, a DOM element over the canvas.

## What the badge shows

By default the line reads:

- "Powered by ImmersiveMap": the engine's own credit, a courtesy rather than a license term.
- "© OpenStreetMap": the hosted tiles. A click opens the OpenStreetMap copyright page in a new tab.
- "Biomes © RESOLVE, CC BY 4.0": the biomes the engine paints on the globe, shown up to zoom 8.
- "© Mapterhorn": the terrain, only while the ground relief is raised.

Each credit shows only at the zooms where its data is on screen.

## Your own data

If you draw your own tiles (see [Setting up the tile source](TileSource.md)), state their credit. It takes the place of "© OpenStreetMap":

```ts
const map = await ImmersiveMap.create({
  container,
  settings: ImmersiveMapSettings.default
    .tileArchive("https://tiles.mycity.example/city.pmtiles")
    .attributionSettings({
      attributionOverride: ImmersiveMapAttribution.single("© My City", "https://mycity.example/license"),
    }),
});
```

The second argument of `ImmersiveMapAttribution.single` is where a click on the badge leads. Data that is on screen only at some zooms gets a credit with a zoom range, from the lower bound up to, not including, the upper one:

```ts
ImmersiveMapAttribution.make([
  ImmersiveMapAttribution.credit("© My City"),
  ImmersiveMapAttribution.credit("Aerial © Survey Office", { lowerBound: 14, upperBound: 22 }),
]);
```

`ImmersiveMapAttribution.make` takes the link as its second argument. The engine still adds the credits of the biomes and the terrain after yours. An empty override (`ImmersiveMapAttribution.none`) removes the whole line.

## The badge's look

```ts
ImmersiveMapSettings.default.attributionSettings({
  size: "small",
  position: "bottomLeading",
  margin: 8,
  respectsBottomSafeArea: true,
  textColor: [0, 0, 0, 0.8],
  emphasizesLeadingCredit: true,
  showsEngineCredit: false,
});
```

- `size`: `"small"`, `"regular"` or `"large"`.
- `position`: a corner (`"bottomTrailing"`, `"bottomLeading"`, `"topTrailing"`, `"topLeading"`) or the middle of the top or bottom edge (`"topCenter"`, `"bottomCenter"`).
- `margin`: CSS pixels between the badge and the edges.
- `respectsBottomSafeArea`: keeps a bottom badge above the home indicator of a phone, for a map that runs under the safe area (`viewport-fit=cover`).
- `textColor`: RGBA from 0 to 1. White by default, and `null` takes the default back.
- `emphasizesLeadingCredit`: sets the first credit in bold.
- `showsEngineCredit`: `false` drops "Powered by ImmersiveMap".

Every value is optional, and the ones you leave out stay as they are.

## Showing the credit yourself

To credit the data in your own UI, an overlay or an about page, hide the badge and say so:

```ts
ImmersiveMapSettings.default
  .attributionSettings({ isVisible: false })
  .attributionProvidedExternally();
```

Without `attributionProvidedExternally()`, a hidden badge logs a warning to the console, once per page. The obligation stays yours: the credit has to be visible on every screen that shows the map. `settings.resolvedAttribution` is the line the badge would show, so your own UI can show the same credits:

```ts
return ImmersiveMapAttribution.creditsAtZoom(settings.resolvedAttribution, zoom)
  .map((credit) => credit.text)
  .join(" · ");
```

The code of this page is in [examples/attribution.ts](examples/attribution.ts).
