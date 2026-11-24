# Development

How this repository is laid out and how to build, run and test it.

## Tools

- Node.js and npm.
- rustup with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` of the version pinned in `Cargo.toml`, and binaryen (`wasm-opt`).
- Chrome, which the smoke tests and the benchmarks drive.

## Layout

- [ImmersiveMapCore](https://github.com/artembobkin/ImmersiveMapCore): the Rust the engine shares with its other ports, a repository of its own and a git dependency of this one (see "The shared core" below). The PMTiles format, the MVT decoder, the style, the tile parse, the terrain decode, the layers' meshes, the model tile's format, the placement planner, the label and pin collisions.
- `crates/worker-wasm`: the Wasm module a tile worker runs (archive navigation, tile preparation, the terrain tiles' decode), a binding over the core.
- `crates/frame-wasm`: the Wasm module of the main thread (the tile coverage, the placement planner, the label collisions, the pin layout), a binding over the core.
- `crates/model-wasm`, `crates/layer-wasm`: the Wasm modules of the model tile worker and of the layers' worker, bindings over the core.
- `crates/fixture-archive`: builds the local test archive from the downloaded fixtures.
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

## The shared core

The crates under `crates/` hold only what is the browser's: the `wasm-bindgen` bindings and the benchmarks. The logic they bind is in [ImmersiveMapCore](https://github.com/artembobkin/ImmersiveMapCore), which `Cargo.toml` names as a git dependency pinned to a commit. Its tests run there (`cargo test --workspace` in a checkout of it), and `npm run test:rust` here runs the bindings' own.

To take a newer core, change the `rev` of every core crate in `Cargo.toml` (and in `crates/bench-rayon/Cargo.toml`) to its commit.

To work on the core and this repository together, check the core out beside this one and add this to the root `Cargo.toml` while you work, without committing it:

```toml
[patch."https://github.com/artembobkin/ImmersiveMapCore"]
pmtiles = { path = "../ImmersiveMapCore/crates/pmtiles" }
tile-prep = { path = "../ImmersiveMapCore/crates/tile-prep" }
ground-relief = { path = "../ImmersiveMapCore/crates/ground-relief" }
layer-mesh = { path = "../ImmersiveMapCore/crates/layer-mesh" }
model-tile = { path = "../ImmersiveMapCore/crates/model-tile" }
map-frame = { path = "../ImmersiveMapCore/crates/map-frame" }
map-worker = { path = "../ImmersiveMapCore/crates/map-worker" }
map-visibility = { path = "../ImmersiveMapCore/crates/map-visibility" }
```

The core's `text-layout` carries a copy of the label atlases' metrics (`atlas.json`, `atlas_thin.json`). When `scripts/encode-atlases.mjs` changes them in `packages/immersive-map/assets`, copy them into the core's `crates/text-layout/assets` as well and raise its `PREPARED_TILE_TEXT_REVISION`.

## The npm package

```sh
npm run build:wasm
npm run build:package       # packages/immersive-map/dist, README.md and LICENSE
cd packages/immersive-map && npm pack --dry-run
```

`scripts/build-package.mjs` compiles the library to ES modules with declarations, the layout of `src` kept file for file, turns the shaders' `?raw` imports into modules of their own, copies the runtime WebAssembly modules and checks that every relative import and `new URL` of the output names a file the package ships. `npm pack` and `npm publish` run it on their own (`prepack`). Inside the repository the playground, the tests and the guide read the TypeScript source instead, through the package's `immersive-map-source` export condition.

To publish a new version: raise `version` in `packages/immersive-map/package.json`, then run `npm publish --access public` in `packages/immersive-map` from a terminal of your own: npm confirms the account's two-factor authentication in the browser, which it offers only in an interactive terminal. Add `--tag next` for a preview release.

## Tests

```sh
npm run fixtures            # download the test tiles and build the local archive (once)
npm run check               # typecheck, shader validation, clippy, cargo test, Vitest
npm run smoke               # Playwright in Chrome with WebGPU
```

The state of the port and its known differences from the Swift engine are in [STATUS.md](STATUS.md) (in Russian). The benchmarks and their verdicts are in [benchmarks](benchmarks/README.md).
