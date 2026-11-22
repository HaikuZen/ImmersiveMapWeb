# The guide

The guide of `@artembobkin/immersive-map`, the browser port of the [ImmersiveMap](https://github.com/artembobkin/ImmersiveMap) Swift engine. Each page has the topic of a page of the Swift engine's `Documentation/`, with the examples on the TypeScript API, and says where the browser differs.

1. [Getting started](GettingStarted.md): what the map needs, the first map, the options and the settings.
2. [Setting up the tile source](TileSource.md): the PMTiles archive, your own archive, maps without the hosted tiles, the disk cache.
3. [Attribution](Attribution.md): the credit badge and the credit of your own data.
4. [Camera](Camera.md): gestures, the starting position, cities, flights, paths, tours, limits and bounds.
5. [Style](Style.md): the theme's colours, night, the globe's palette, the language of the names.
6. [Custom style](CustomStyle.md): the Swift engine's own styles and schemas, which the port does not have, and the theme in their place.
7. [Relief](Relief.md): the ground relief, its terrain source, shading and the mountains around the camera.
8. [The scene](Scene.md): the globe and space, the sun and the shadows, the sky and the fog, the buildings and the trees.
9. [Your own data](Layers.md): GeoJSON and shapes as layers, their styles, updates, memory and taps.
10. [Annotations, pins and taps](AnnotationsAndPins.md): DOM annotations, pins and their frame, taps and selection.
11. [3D content](3DContent.md): building models from a model archive, and your own glTF, GLB and OBJ models.
12. [Export](Export.md): pictures and MP4 videos of the map.

## The examples

Every code block of the guide is an excerpt of a file in [examples/](examples/). `npm run typecheck` compiles those files against the library's source (`tsc -p docs/guide`), and `scripts/check-guide.mjs` checks that every line of every block is found in them, so a page cannot drift from the API.

## Differences from the Swift engine

The pages name each difference where it comes up. In short:

- The map is a class on a container element, `ImmersiveMap.create({ container })`, not a SwiftUI view. The SwiftUI modifiers are options of `ImmersiveMap.create` and methods of `ImmersiveMapSettings`, applied to a running map with `map.setSettings`.
- WebGPU only. No COOP or COEP headers are needed.
- Annotations are DOM elements. In a video they are drawn from a picture of each one (`exportImage`).
- Videos are MP4 files from WebCodecs, returned as a `Blob`, in place of QuickTime files.
- Scene models are glTF, GLB and OBJ files fetched from URLs, in place of USDZ and OBJ files on disk.
- POI icons come from Maki in place of SF Symbols.
- There is no style or schema of your own, no window sized to a platform's format, no low-memory handling of the layers and no wireframe debug mode.
