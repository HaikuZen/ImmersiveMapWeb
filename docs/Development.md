# Development

How this repository is laid out and how to build, run and test it.

## Tools

- Node.js and npm.
- rustup with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` of the version pinned in `Cargo.toml`, and binaryen (`wasm-opt`).
- Chrome, which the smoke tests and the benchmarks drive.

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
