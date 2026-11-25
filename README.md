# ImmersiveMap Web

[![npm](https://img.shields.io/npm/v/@artembobkin/immersive-map?style=flat-square)](https://www.npmjs.com/package/@artembobkin/immersive-map) [![License](https://img.shields.io/github/license/artembobkin/ImmersiveMapWeb?style=flat-square)](LICENSE)

ImmersiveMap Web is a **WebGPU map** rendering engine for **web pages**, written in TypeScript with a Rust core compiled to WebAssembly. It is the browser version of [ImmersiveMap](https://github.com/artembobkin/ImmersiveMap), the Swift and Metal engine for Apple platforms.

**[Live demo](https://artembobkin.github.io/ImmersiveMapWeb/)** (a browser with WebGPU: Chrome, Edge, Safari 26).

<!-- The same views as the Swift engine's README, rendered by this engine in Chrome (scripts/screenshots.mjs). -->
<p align="center">
  <img src="Assets/readme-globe-europe.avif" width="100%" alt="The globe over Europe: biomes, the road network and the atmosphere">
</p>
<p align="center">
  <img src="Assets/readme-matterhorn.avif" width="49%" alt="The Matterhorn's summit on the terrain relief, with the hillshade and the mountain shadows">
  <img src="Assets/readme-zermatt-valley.avif" width="49%" alt="The valley of Zermatt from above, the relief under the land cover and the mountain air">
</p>
<p align="center">
  <img src="Assets/readme-manhattan.avif" width="49%" alt="Lower Manhattan with extruded buildings, shadows and street names">
  <img src="Assets/readme-rome.avif" width="49%" alt="The Roman Forum from a tilted camera, with the points of interest">
</p>
<p align="center">
  <img src="Assets/readme-moscow-city.avif" width="49%" alt="The towers of Moscow City over the Third Ring Road">
  <img src="Assets/readme-kremlin.avif" width="49%" alt="The Kremlin wall and the Saviour Tower from the model archive">
</p>
<p align="center">
  <img src="Assets/readme-bolshoi.avif" width="49%" alt="The Bolshoi Theatre at street level, a 3D model standing in for the building">
  <img src="Assets/readme-paris-region.avif" width="49%" alt="Paris and its suburbs on the relief, with the route shields">
</p>
<p align="center">
  <img src="Assets/readme-san-francisco.avif" width="49%" alt="San Francisco's hills on the relief, toward the bay">
  <img src="Assets/readme-san-francisco-downtown.avif" width="49%" alt="Downtown San Francisco from above, with the points of interest">
</p>
<p align="center">
  <img src="Assets/readme-berlin-night.avif" width="49%" alt="Berlin Mitte in the dark palette">
  <img src="Assets/readme-avatars-shibuya.avif" width="49%" alt="Pins over Shibuya, making room for each other">
</p>
<p align="center">
  <img src="Assets/readme-scene-models-paris.avif" width="49%" alt="A 3D scene model by the Eiffel Tower">
  <img src="Assets/readme-avatars-globe.avif" width="49%" alt="Pins on the globe">
</p>

## Features

Built-in Protomaps vector tiles from a PMTiles archive, offline maps from a PMTiles file your own site serves, a globe that unrolls into a flat map, terrain relief, map styling and colors, your own data as layers (GeoJSON zones, lines and points), DOM annotations, pins that make room for each other, a tile grid your users pick XYZ tiles on, 3D scene models (glTF, GLB and OBJ), 3D building models from a PMTiles model archive, tour video export.

## Map Data

The map draws OpenStreetMap data from a single [PMTiles](https://docs.protomaps.com/pmtiles/) file with no tile server. Out of the box it works online: the map streams a hosted archive of the whole planet over HTTP, loading only the tiles in view. I host that archive on Cloudflare R2 as a public source for this library, so that you can see the map right away. You are free to host an archive yourself, wherever you like: any storage that serves HTTP range requests will do (R2, S3, a CDN, your own server). The 3D building models come from a second PMTiles archive, which the map draws once you turn it on, and the globe's biomes ship inside the package. To point the map at an archive you host, pass its URL: `ImmersiveMap.create({ container, url: "https://example.com/planet.pmtiles" })`.

The same map works with no outside network: serve a `.pmtiles` file from your own origin and point the map at it.

## Quick Start

```ts
import { ImmersiveMap } from "@artembobkin/immersive-map";

const map = await ImmersiveMap.create({
  container: document.getElementById("map")!,
});
```

The map fills the container with a canvas, so give the container a size in CSS.

## Installation

Add the package from npm:

```sh
npm install @artembobkin/immersive-map
```

It ships ES modules with their type declarations, the WebAssembly modules and the assets. Your bundler copies them next to your app with no configuration: Vite and webpack 5 are checked.

## Requirements

- A browser with WebGPU. There is no WebGL fallback: Chrome and Edge 113+, Chrome for Android 121+, Safari 26+, Firefox 141+ on Windows
- A secure context (HTTPS or `localhost`)
- A bundler that follows `new URL(…, import.meta.url)` and module workers, such as Vite or webpack 5
- TypeScript 6+ for the types (or `@webgpu/types` with an older one)
- No cross-origin isolation: the map needs no COOP or COEP headers
- WebCodecs for the video export only

The engine is developed and tested in Chrome on macOS. The other browsers and platforms are not tested yet.

## Attribution

The default map is built from open data, and three of its sources ask to be credited:

1. **OpenStreetMap**: the built-in vector tiles are OpenStreetMap data under ODbL, so "© OpenStreetMap" is required.
2. **RESOLVE Ecoregions 2017**: the biomes the engine paints under the land of the globe are under CC BY 4.0, so "Biomes © RESOLVE" is required while they are on screen.
3. **Mapterhorn**: the terrain the ground relief rises by is Mapterhorn's open elevation data, so "© Mapterhorn" is required while the relief is on screen.

The map's badge shows these credits on its own. The engine is MIT licensed, and its "Powered by ImmersiveMap" credit is not required.

## Contributing

ImmersiveMap is made and maintained by Artem Bobkin, as a single-maintainer project. Pull requests are accepted.

To build and run the repository you need Node.js, rustup with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` of the version pinned in `Cargo.toml`, binaryen (`wasm-opt`) and Chrome:

```sh
npm install
npm run build:wasm   # the Rust to Wasm
npm run dev          # the map with the feature in work, http://localhost:5180
npm run e2e:app      # the app the e2e tests run in, every sample, http://localhost:5173
npm run fixtures     # the test tiles, once
npm run check        # types, shaders, clippy, cargo test, Vitest
npm run e2e          # the e2e tests: Playwright in Chrome with WebGPU, in the e2e app
```

The Rust shared with the engine's other ports is [ImmersiveMapCore](https://github.com/artembobkin/ImmersiveMapCore), a git dependency pinned to a commit in `Cargo.toml`.

## License

ImmersiveMap Web is © Artem Bobkin, available under the MIT license. See [LICENSE](LICENSE).

## Support

Feel free to open an [issue](https://github.com/artembobkin/ImmersiveMapWeb/issues/new) with a question, a bug or an idea. I am happy to help.
