#!/bin/sh
# B17 only: builds crates/bench-rayon with nightly Rust (atomics and a std
# rebuilt with them) for wasm-bindgen-rayon, into packages/immersive-map/src/wasm/bench_rayon.
set -eu
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+simd128,+nontrapping-fptoint,+sign-ext,+mutable-globals -C link-arg=--shared-memory -C link-arg=--max-memory=4294967296 -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base" \
  cargo +nightly build --release --target wasm32-unknown-unknown -Z build-std=panic_abort,std \
  --manifest-path crates/bench-rayon/Cargo.toml --target-dir target/bench-rayon
wasm-bindgen --target web --out-dir packages/immersive-map/src/wasm/bench_rayon target/bench-rayon/wasm32-unknown-unknown/release/bench_rayon.wasm
# The helper imports its package as '../../..', which assumes a wasm-pack
# package.json. Point it at the generated module itself. `-i.orig` and
# the backup removed, as BSD and GNU sed both take it.
for helper in packages/immersive-map/src/wasm/bench_rayon/snippets/*/src/workerHelpers.js; do
  sed -i.orig "s#import('../../..')#import('../../../bench_rayon.js')#" "$helper"
  rm -f "$helper.orig"
done
