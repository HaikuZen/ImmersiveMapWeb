// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The Wasm module a tile worker runs. It owns no IO: the worker's
//! TypeScript fetches the byte ranges this module names and inflates them,
//! and this module walks the archive's directories and prepares the tiles.
//! It decodes the relief's terrain tiles too (`terrain`). The work itself is
//! the crates of ImmersiveMapCore, shared with the other hosts, and this
//! module is their binding to JavaScript.

use pmtiles::{ArchiveContents, ArchiveDirectories};
use tile_prep::Preparer;
use wasm_bindgen::prelude::*;

mod parse;
mod terrain;
pub use parse::{ParsedTile, TileParser};
pub use terrain::{DecodedTerrain, decode_terrain_tile};

#[wasm_bindgen]
pub struct Archive {
    inner: ArchiveDirectories,
}

/// Where a tile is, or which leaf directory must be fetched to find out.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum LocateKind {
    Tile = 0,
    NeedLeaf = 1,
    Missing = 2,
}

#[wasm_bindgen]
pub struct Located {
    pub kind: LocateKind,
    /// The absolute byte offset in the archive (exact in an f64 below 2^53).
    pub offset: f64,
    pub length: u32,
}

fn error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
impl Archive {
    #[wasm_bindgen(constructor)]
    pub fn new(header_bytes: &[u8]) -> Result<Archive, JsError> {
        // The engine reads gzip or uncompressed MVT, as the Swift client does.
        Ok(Archive { inner: ArchiveDirectories::new(header_bytes, ArchiveContents::VectorTiles).map_err(error)? })
    }

    #[wasm_bindgen(getter, js_name = rootOffset)]
    pub fn root_offset(&self) -> f64 {
        self.inner.header().root_directory_offset as f64
    }

    #[wasm_bindgen(getter, js_name = rootLength)]
    pub fn root_length(&self) -> u32 {
        self.inner.header().root_directory_length as u32
    }

    /// 1 none, 2 gzip, 3 brotli, 4 zstd.
    #[wasm_bindgen(getter, js_name = internalCompression)]
    pub fn internal_compression(&self) -> u8 {
        self.inner.header().internal_compression as u8
    }

    #[wasm_bindgen(getter, js_name = tileCompression)]
    pub fn tile_compression(&self) -> u8 {
        self.inner.header().tile_compression as u8
    }

    #[wasm_bindgen(getter, js_name = minZoom)]
    pub fn min_zoom(&self) -> u8 {
        self.inner.header().min_zoom
    }

    #[wasm_bindgen(getter, js_name = maxZoom)]
    pub fn max_zoom(&self) -> u8 {
        self.inner.header().max_zoom
    }

    #[wasm_bindgen(js_name = setRoot)]
    pub fn set_root(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.set_root(bytes).map_err(error)
    }

    #[wasm_bindgen(js_name = addLeaf)]
    pub fn add_leaf(&mut self, absolute_offset: f64, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.add_leaf(absolute_offset as u64, bytes).map_err(error)
    }

    /// The PMTiles tile id of z/x/y, exact in an f64 through zoom 26.
    #[wasm_bindgen(js_name = tileId)]
    pub fn tile_id(z: u8, x: u32, y: u32) -> f64 {
        pmtiles::tile_id(z, x, y).map(|id| id as f64).unwrap_or(-1.0)
    }

    /// Forgets the leaf directories: the archive was replaced.
    #[wasm_bindgen(js_name = clearLeaves)]
    pub fn clear_leaves(&mut self) {
        self.inner.clear_leaves();
    }

    pub fn locate(&mut self, z: u8, x: u32, y: u32) -> Result<Located, JsError> {
        Ok(match self.inner.locate(z, x, y).map_err(error)? {
            pmtiles::Located::Tile { offset, length } => Located { kind: LocateKind::Tile, offset: offset as f64, length },
            pmtiles::Located::NeedLeaf { offset, length } => Located { kind: LocateKind::NeedLeaf, offset: offset as f64, length },
            pmtiles::Located::Missing => Located { kind: LocateKind::Missing, offset: 0.0, length: 0 },
        })
    }
}

/// A prepared tile handed to JavaScript. The buffers are copied out of the
/// Wasm memory into fresh JS buffers, which the worker then transfers.
#[wasm_bindgen]
pub struct PreparedTile {
    vertices: Vec<u32>,
    indices: Vec<u32>,
    #[wasm_bindgen(js_name = featureCount)]
    pub feature_count: u32,
}

#[wasm_bindgen]
impl PreparedTile {
    #[wasm_bindgen(js_name = takeVertices)]
    pub fn take_vertices(&mut self) -> js_sys::Uint32Array {
        let array = js_sys::Uint32Array::from(&self.vertices[..]);
        self.vertices = Vec::new();
        array
    }

    #[wasm_bindgen(js_name = takeIndices)]
    pub fn take_indices(&mut self) -> js_sys::Uint32Array {
        let array = js_sys::Uint32Array::from(&self.indices[..]);
        self.indices = Vec::new();
        array
    }
}

#[wasm_bindgen]
pub struct TilePreparer {
    inner: Preparer,
}

#[wasm_bindgen]
impl TilePreparer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TilePreparer {
        TilePreparer { inner: Preparer::new() }
    }

    pub fn prepare(&mut self, mvt: &[u8], z: u8) -> Result<PreparedTile, JsError> {
        let tile = self.inner.prepare(mvt, z).map_err(error)?;
        Ok(PreparedTile { vertices: tile.vertices, indices: tile.indices, feature_count: tile.feature_count })
    }
}

impl Default for TilePreparer {
    fn default() -> Self {
        Self::new()
    }
}
