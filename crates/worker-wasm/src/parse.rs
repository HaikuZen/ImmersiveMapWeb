// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The binding of the tile parser a worker runs (`map_worker::tile_parser`):
//! one call takes a tile's MVT bytes and returns its GPU arena and the
//! metadata JSON beside it.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct TileParser {
    inner: map_worker::tile_parser::TileParser,
}

/// A parsed tile handed to JavaScript.
#[wasm_bindgen]
pub struct ParsedTile {
    arena: Vec<u8>,
    meta: String,
}

#[wasm_bindgen]
impl ParsedTile {
    /// The arena, copied into a fresh JS buffer the worker transfers.
    #[wasm_bindgen(js_name = takeArena)]
    pub fn take_arena(&mut self) -> js_sys::Uint8Array {
        let array = js_sys::Uint8Array::from(&self.arena[..]);
        self.arena = Vec::new();
        array
    }

    /// The metadata as JSON.
    #[wasm_bindgen(getter)]
    pub fn meta(&self) -> String {
        self.meta.clone()
    }
}

#[wasm_bindgen]
impl TileParser {
    /// `config` is the JSON of the parser's configuration. An empty string takes every default.
    #[wasm_bindgen(constructor)]
    pub fn new(config: &str) -> Result<TileParser, JsError> {
        Ok(TileParser { inner: map_worker::tile_parser::TileParser::new(config).map_err(|e| JsError::new(&e))? })
    }

    /// The version of the prepared arena format: part of the disk cache's identity.
    #[wasm_bindgen(getter, js_name = formatVersion)]
    pub fn format_version(&self) -> u32 {
        self.inner.format_version()
    }

    /// The revision of how label text is laid out into a prepared tile, the
    /// bundled atlases included: part of the disk cache's identity.
    #[wasm_bindgen(getter, js_name = textRevision)]
    pub fn text_revision(&self) -> u32 {
        self.inner.text_revision()
    }

    /// The revision of what the style bakes into a prepared tile: part of the disk cache's identity.
    #[wasm_bindgen(getter, js_name = styleRevision)]
    pub fn style_revision(&self) -> u32 {
        self.inner.style_revision()
    }

    pub fn parse(&self, mvt: &[u8], z: i32, x: i32, y: i32) -> Result<ParsedTile, JsError> {
        let parsed = self.inner.parse(mvt, z, x, y).map_err(|e| JsError::new(&e))?;
        Ok(ParsedTile { arena: parsed.arena, meta: parsed.meta })
    }
}
