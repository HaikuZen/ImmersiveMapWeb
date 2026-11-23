// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The model archive's directories, with the same JS API as the map tile
//! worker's `Archive` (crates/worker-wasm), so the TypeScript
//! `PMTilesArchiveClient` drives either module. The walk itself is shared
//! (`pmtiles::ArchiveDirectories`). The binding is a copy and not a shared
//! crate: it is thin, and exports of `#[wasm_bindgen]` items from a
//! dependency rlib reach the final module only when something references
//! them.

use pmtiles::{ArchiveContents, ArchiveDirectories};
use wasm_bindgen::prelude::*;

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
        // A model archive's tiles are of the type PMTiles has no name for,
        // as the Swift engine's model source asks (`tileType: .unknown`).
        Ok(Archive { inner: ArchiveDirectories::new(header_bytes, ArchiveContents::ModelTiles).map_err(error)? })
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
