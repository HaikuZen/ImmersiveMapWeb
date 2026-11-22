# Relief

The relief raises the ground into mountains and valleys, from real terrain heights. The roads, the buildings and the labels rise with it, the slopes are shaded by the light, and the camera flies over the ridges.

It is off by default. Turn it on:

```ts
const map = await ImmersiveMap.create({
  container,
  camera: { center: [7.7491, 46.0207], zoom: 12, pitch: 1.1 },
  settings: ImmersiveMapSettings.default.groundRelief({ isEnabled: true }),
});
```

## When it shows

The relief rises out of the flat map at zoom 10 and sinks back into it at zoom 13.7. At street zooms the terrain data, 30 m cells over most of the world, would show hills where there are none, so the map lies flat there. Both changes are short animations, 0.3 seconds by default.

```ts
ImmersiveMapSettings.default.groundRelief({
  isEnabled: true,
  appearZoom: 9,
  collapseZoom: 15,
  transitionSeconds: 0.5,
});
```

Where the terrain has finer data, such as lidar in some countries, the relief stands up to `collapseZoom`. Elsewhere it sinks earlier, at the first zoom the source has no tile for. `collapsesWhereTerrainIsMissing: false` keeps it up to `collapseZoom` everywhere.

A change to most of these values on a running map builds the map's GPU side again (see [Getting started](GettingStarted.md#changing-the-settings)), so set them once.

## Height

`exaggeration` multiplies every height: 1 is true scale, 2 doubles it. Raise it to make a gentle country readable.

```ts
ImmersiveMapSettings.default.groundRelief({ isEnabled: true, exaggeration: 1.5 });
```

## The terrain source

By default the heights come from [Mapterhorn](https://mapterhorn.com), open terrain for the whole world, credited on the map while the relief stands. Use your own terrain tiles with `.terrain(...)`:

```ts
ImmersiveMapSettings.default
  .terrain(
    ImmersiveMapTerrainSource.make({
      tileURLTemplate: "https://terrain.example.com/{z}/{x}/{y}.png",
      encoding: "mapbox",
      credit: "© Example Terrain",
    }),
  )
  .groundRelief({ isEnabled: true });
```

The tiles are square PNG or WebP images whose pixels hold heights: `"terrarium"` (Mapterhorn, AWS Terrain Tiles, the default) or `"mapbox"` (Mapbox Terrain-RGB, MapTiler). A template on another origin has to allow the page by CORS. The Swift engine also reads a file URL template from disk. In the browser the template is an HTTP URL, a path on the app's own origin included.

## Shading

The style shades the slopes and darkens the valleys where the terrain hides the sky. Tune both in the theme:

```ts
settings.mapStyle.theme.hillshade.intensity = 0.5;
settings.mapStyle.theme.terrainOcclusion.strength = 0.3;
```

These lines run inside `settings.edit(...)`, as on the [Style](Style.md) page. Both apply while drawing, so a change parses nothing. With shadows on, the mountains also cast shadows (`castsShadows`, on by default).

## The camera

The camera keeps its height over the ground and stops at a ridge between it and the point it looks at. `cameraClearanceMetres` keeps it that many metres over such a ridge:

```ts
ImmersiveMapSettings.default.groundRelief({ isEnabled: true, cameraClearanceMetres: 50 });
```

## Mountains or plain

The map can tell you whether the camera is over mountains or a plain, to adapt your UI or the air:

```ts
const stop = map.onTerrainSurroundingsChange((surroundings) => {
  // surroundings?.kind is "mountains" or "plain", null off the relief
  badge.textContent = surroundings === null ? "" : surroundings.kind;
});
```

The listener returns the function that stops it. `map.terrainSurroundings` reads the last frame's reading, which also carries `mountainousness` (0 on a plain, 1 in the mountains), `heightSpanMetres` and `groundMetres`.

`.terrainSurroundings({ sampleRadiusMetres, plainBelowMetres, mountainsAboveMetres, smoothingHalfLife })` sets how wide an area is read and which span of heights counts as mountains:

```ts
ImmersiveMapSettings.default.terrainSurroundings({
  sampleRadiusMetres: 3000,
  plainBelowMetres: 150,
  mountainsAboveMetres: 600,
  smoothingHalfLife: 0.5,
});
```

The map itself uses this to blend into the mountain air of `.mountainGroundFog(...)` (see [The scene](Scene.md)).

The code of this page is in [examples/relief.ts](examples/relief.ts).
