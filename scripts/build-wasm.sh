#!/bin/sh
# Builds the Rust crates to WebAssembly and writes their JS bindings into
# packages/immersive-map/src/wasm/<crate>, optimized by wasm-opt.
set -eu
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

cargo build --release --target wasm32-unknown-unknown -p worker-wasm -p frame-wasm -p layer-wasm -p model-wasm

OUT=packages/immersive-map/src/wasm
FEATURES="--enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-multivalue --enable-reference-types"
for crate in worker_wasm frame_wasm layer_wasm model_wasm; do
  wasm-bindgen --target web --out-dir "$OUT/$crate" "target/wasm32-unknown-unknown/release/$crate.wasm"
  wasm-opt -O3 $FEATURES "$OUT/$crate/${crate}_bg.wasm" -o "$OUT/$crate/${crate}_bg.wasm"
  printf '%-14s %8s bytes, %8s gzip, %8s brotli\n' "$crate" \
    "$(wc -c < "$OUT/$crate/${crate}_bg.wasm" | tr -d ' ')" \
    "$(gzip -9c "$OUT/$crate/${crate}_bg.wasm" | wc -c | tr -d ' ')" \
    "$( (brotli -c -q 11 "$OUT/$crate/${crate}_bg.wasm" 2>/dev/null || echo) | wc -c | tr -d ' ')"
done
