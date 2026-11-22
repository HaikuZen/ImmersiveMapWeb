// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The model archive's directories, with the same JS API as the map tile
//! worker's `Archive` (crates/worker-wasm), so the TypeScript
//! `PMTilesArchiveClient` drives either module. The wrapper is a copy and
//! not a shared crate: it is thin, the two modules ask different things of
//! the header (vector tiles there, model tiles here), and exports of
//! `#[wasm_bindgen]` items from a dependency rlib reach the final module
//! only when something references them.

use pmtiles::{Compression, Directory, DirectoryCache, Header, Lookup, TileType};
use wasm_bindgen::prelude::*;

/// How deep leaf directories may nest before the archive is taken as corrupt.
const MAXIMUM_DIRECTORY_DEPTH: usize = 4;

#[wasm_bindgen]
pub struct Archive {
    header: Header,
    root: Directory,
    /// Leaf directories by their absolute byte offset in the archive.
    leaves: DirectoryCache,
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
        let header = Header::decode(header_bytes).map_err(error)?;
        // A model archive's tiles are of the type PMTiles has no name for,
        // as the Swift engine's model source asks (`tileType: .unknown`).
        if header.tile_type != TileType::Unknown {
            return Err(JsError::new(&format!("tile type {:?} is not model tiles", header.tile_type)));
        }
        for compression in [header.internal_compression, header.tile_compression] {
            if !matches!(compression, Compression::None | Compression::Gzip | Compression::Unknown) {
                return Err(JsError::new(&format!("compression {compression:?} is not supported")));
            }
        }
        Ok(Archive { header, root: Directory::default(), leaves: DirectoryCache::new(DirectoryCache::DEFAULT_COST_LIMIT) })
    }

    #[wasm_bindgen(getter, js_name = rootOffset)]
    pub fn root_offset(&self) -> f64 {
        self.header.root_directory_offset as f64
    }

    #[wasm_bindgen(getter, js_name = rootLength)]
    pub fn root_length(&self) -> u32 {
        self.header.root_directory_length as u32
    }

    /// 1 none, 2 gzip, 3 brotli, 4 zstd.
    #[wasm_bindgen(getter, js_name = internalCompression)]
    pub fn internal_compression(&self) -> u8 {
        self.header.internal_compression as u8
    }

    #[wasm_bindgen(getter, js_name = tileCompression)]
    pub fn tile_compression(&self) -> u8 {
        self.header.tile_compression as u8
    }

    #[wasm_bindgen(getter, js_name = minZoom)]
    pub fn min_zoom(&self) -> u8 {
        self.header.min_zoom
    }

    #[wasm_bindgen(getter, js_name = maxZoom)]
    pub fn max_zoom(&self) -> u8 {
        self.header.max_zoom
    }

    #[wasm_bindgen(js_name = setRoot)]
    pub fn set_root(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.root = Directory::decode(bytes).map_err(error)?;
        Ok(())
    }

    #[wasm_bindgen(js_name = addLeaf)]
    pub fn add_leaf(&mut self, absolute_offset: f64, bytes: &[u8]) -> Result<(), JsError> {
        let directory = Directory::decode(bytes).map_err(error)?;
        let cost = directory.entries.len() * 24;
        self.leaves.insert(absolute_offset as u64, directory, cost);
        Ok(())
    }

    /// The PMTiles tile id of z/x/y, exact in an f64 through zoom 26.
    #[wasm_bindgen(js_name = tileId)]
    pub fn tile_id(z: u8, x: u32, y: u32) -> f64 {
        pmtiles::tile_id(z, x, y).map(|id| id as f64).unwrap_or(-1.0)
    }

    /// Forgets the leaf directories: the archive was replaced.
    #[wasm_bindgen(js_name = clearLeaves)]
    pub fn clear_leaves(&mut self) {
        self.leaves.clear();
    }

    pub fn locate(&mut self, z: u8, x: u32, y: u32) -> Result<Located, JsError> {
        let missing = Located { kind: LocateKind::Missing, offset: 0.0, length: 0 };
        let Some(id) = pmtiles::tile_id(z, x, y) else { return Ok(missing) };
        let mut lookup = self.root.lookup(id);
        for _ in 0..MAXIMUM_DIRECTORY_DEPTH {
            match lookup {
                Lookup::Tile(entry) => {
                    return Ok(Located {
                        kind: LocateKind::Tile,
                        offset: (self.header.tile_data_offset + entry.offset) as f64,
                        length: entry.length,
                    });
                }
                Lookup::Leaf(entry) => {
                    let offset = self.header.leaf_directories_offset + entry.offset;
                    match self.leaves.get(offset) {
                        Some(leaf) => lookup = leaf.lookup(id),
                        None => {
                            return Ok(Located { kind: LocateKind::NeedLeaf, offset: offset as f64, length: entry.length });
                        }
                    }
                }
                Lookup::Missing => return Ok(missing),
            }
        }
        Err(JsError::new("PMTiles: leaf directories nest too deep"))
    }
}
