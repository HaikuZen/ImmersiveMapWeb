# Setting up the tile source

The map draws from one file: a [PMTiles](https://docs.protomaps.com/pmtiles/) v3 archive of vector tiles (MVT, gzip-compressed or not). The engine reads it with HTTP range requests, so any static host serves it, and no tile server is needed.

## The default

A map with default settings draws the hosted archive, `ImmersiveMapTilesService.tileArchiveURL`: the whole planet from OpenStreetMap, credited "© OpenStreetMap" on the map.

## Your own archive

```ts
const map = await ImmersiveMap.create({
  container,
  settings: ImmersiveMapSettings.default.tileArchive("https://tiles.example.com/planet.pmtiles"),
});
```

The `url` option of `ImmersiveMap.create` does the same for one map, and takes the place of the archive in the settings it is given:

```ts
const map = await ImmersiveMap.create({ container, url: "https://tiles.example.com/planet.pmtiles" });
```

- **Schema.** The built-in style reads tiles in the Protomaps basemap schema, the one the hosted archive uses. The browser port has no style or schema of your own, so an archive in another schema does not draw correctly (see [Custom style](CustomStyle.md)).
- **CORS.** The page reads the archive with `fetch`, so an archive on another origin must allow the page by CORS and allow the `Range` request header. The hosted archive does.
- **Keys.** A query string is sent as written, so a key can live in the URL. Credentials sent as headers go in the second argument, and are added to every request. A header other than `Range` has to be allowed by the host's CORS policy too.
  ```ts
  const settings = ImmersiveMapSettings.default.tileArchive("https://tiles.example.com/planet.pmtiles", {
    Authorization: `Bearer ${token}`,
  });
  ```
- **Depth.** The map reads how deep the archive goes from its header, and never asks for a deeper tile. Past that zoom, the deepest tiles are stretched. To read less, cap it with `.tileMaximumZoomLevel(14)`.
- **Updates.** You can upload a new archive under the same URL. The map notices by the ETag the host sends, and parses the changed tiles again. A host that sends no ETag needs a new URL for each upload. The host has to expose the `ETag` header to the page by CORS (`Access-Control-Expose-Headers`).

## Offline maps

The Swift engine reads a `.pmtiles` file from the app's bundle through a file URL. A page has no file URLs, so the browser counterpart is an archive served by the app's own origin, at a path next to the page:

```ts
const map = await ImmersiveMap.create({
  container,
  settings: ImmersiveMapSettings.default
    .tileArchive("/maps/city.pmtiles"),
});
```

- **The network.** The tiles come from the app's own server, so the map needs no tile server and no connection to `tiles.immersivemap.dev`. Any server that answers range requests works, static hosts included. A page that has to work with no network at all also needs a service worker that caches the archive and answers range requests from it, which the library does not provide.
- **3D building models.** The map reads none by default. A map that wants them names an archive with `.modelArchive(url)`, the hosted one or a PMTiles file of models on its own origin (see [3D content](3DContent.md)).
- **Relief.** The relief is off by default. Turned on, it loads its heights from Mapterhorn unless `.terrain(...)` names a URL template of your own, which can point at your own origin too (see [Relief](Relief.md)).
- **The globe.** The biomes and the roads of the far zooms ship inside the package, and need nothing.
- **The file.** Any PMTiles v3 archive of vector tiles in the Protomaps basemap schema works. One city at full depth is tens of megabytes, and the whole planet is over a hundred gigabytes, so cut the area an app serves (the `pmtiles extract` command of the [PMTiles tool](https://docs.protomaps.com/pmtiles/cli) does it).

## Caching

The map keeps every tile it has parsed on disk, in the page's IndexedDB, up to 2 GiB by default, so a place seen before comes back without the network. Set the size in the unit that reads best:

```ts
ImmersiveMapSettings.default.preparedTileDiskCacheSize(ImmersiveMapByteCount.gigabytes(4));
```

The size is an `ImmersiveMapByteCount`: `ImmersiveMapByteCount.gigabytes(...)`, `.megabytes(...)`, `.kilobytes(...)` or `.bytes(...)`. Fractions work, as in `ImmersiveMapByteCount.megabytes(1.5)`. A gigabyte here is 1024 megabytes. The cache is shared by every map of the page's origin, and the most recently created map sets its size. The browser's storage quota for the origin is the upper limit: a browser may hold the cache to less than the size you set, or evict it under storage pressure.

The code of this page is in [examples/tile-source.ts](examples/tile-source.ts).
