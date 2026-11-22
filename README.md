# ImmersiveMap Web

The browser port of [ImmersiveMap](https://github.com/artembobkin/ImmersiveMap): a map library on WebGPU, with a Rust core compiled to WebAssembly. Only current browsers with WebGPU are targeted.

## Documentation

The guide is in [docs/guide](docs/guide/README.md), starting with [Getting started](docs/guide/GettingStarted.md). Its examples are TypeScript files that `npm run typecheck` compiles.

```ts
import { ImmersiveMap } from "@immersive-map/web";

const map = await ImmersiveMap.create({ container: document.getElementById("map")!, camera: { city: "paris", zoom: 15 } });
```

## Requirements

- **WebGPU**, with no WebGL fallback: Chrome and Edge 113 or later on the desktop, Chrome 121 or later on Android, Safari 26 or later, Firefox 141 or later on Windows. The smoke tests run in Chrome.
- **A secure context** (HTTPS or `localhost`), where browsers expose WebGPU.
- **WebCodecs** (`VideoEncoder`) for the video export only.
- No cross-origin isolation: the library needs no COOP or COEP headers. The playground's dev server sends them only for the benchmarks' timers.
- A bundler that compiles the package's TypeScript source and module workers, such as Vite (see `apps/playground`).

## Layout

- `crates/pmtiles`: the PMTiles v3 format (header, directories, Hilbert tile id), pure Rust, no IO.
- `crates/mvt`: a zero-copy Mapbox Vector Tile decoder.
- `crates/tile-prep`: an MVT tile in, a GPU-ready vertex and index buffer out (prototype style).
- `crates/worker-wasm`: the Wasm module a tile worker runs (archive navigation, tile preparation, the terrain tiles' decode).
- `crates/ground-relief`: the terrain tiles' decoder (Terrarium and Mapbox in WebP or PNG to half-float heights), pure Rust.
- `crates/bench-wgpu`: the Rust half of the draw-call benchmark.
- `packages/immersive-map`: the TypeScript library: the public API, the WebGPU renderer, the worker pool.
- `apps/playground`: the dev pages: the map (`index.html`) and the benchmark (`bench.html`).

## Commands

```sh
npm install
npm run build:wasm          # Rust to Wasm, bindings into packages/immersive-map/src/wasm
npm run dev                 # build the Wasm, then serve the playground on http://localhost:5173
npm run typecheck
npm run test:rust
node scripts/probe.mjs http://localhost:4173 <dir>   # headless Chrome: screenshot, stats, benchmark (after `vite preview`)
```

Needs rustup with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` of the version pinned in `Cargo.toml`, and binaryen (`wasm-opt`).
