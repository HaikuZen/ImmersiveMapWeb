// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The Wasm module a model tile worker runs. It owns no IO: the worker's
//! TypeScript fetches the byte ranges this module names (`Archive`) and
//! inflates them, and this module decodes a model tile (`decodeModelTile`)
//! into what the main thread uploads: the vertex and index blocks as
//! stored, the texture array as stored ASTC or decoded to RGBA8 for a GPU
//! without ASTC (decision B14), and a JSON description of the rest.

use std::ops::Range;

use wasm_bindgen::prelude::*;

mod archive;
mod tile;

pub use archive::{Archive, Located, LocateKind};
use tile::{PreparedTile, TextureBytes, TextureMode, prepare};

/// A model tile decoded and checked. The blocks stay in the tile's bytes
/// as they came into Wasm memory until a take method copies each out once.
#[wasm_bindgen]
pub struct DecodedModelTile {
    meta: String,
    bytes: Vec<u8>,
    vertices: Range<usize>,
    indices: Range<usize>,
    texture: TextureBytes,
}

/// Decodes a model tile's bytes (inflated) fetched for z/x/y, checks that
/// the tile is that tile and that its geometry names nothing past its
/// blocks, and prepares its texture: `texture_mode` 0 passes the ASTC
/// blocks through as stored, 1 decodes them to RGBA8. Throws with the
/// format's message for bytes that are not a readable tile of z/x/y, which
/// the worker answers as an unreadable tile.
#[wasm_bindgen(js_name = decodeModelTile)]
pub fn decode_model_tile(bytes: Vec<u8>, z: u32, x: u32, y: u32, texture_mode: u8) -> Result<DecodedModelTile, JsError> {
    let mode = TextureMode::from_byte(texture_mode).map_err(|e| JsError::new(&e))?;
    let PreparedTile { meta, vertices, indices, texture } = prepare(&bytes, z, x, y, mode).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(DecodedModelTile { meta, bytes, vertices, indices, texture })
}

#[wasm_bindgen]
impl DecodedModelTile {
    /// The tile's description as JSON: its counts, bounds, position matrix,
    /// models, the replaced buildings as map tile feature ids by zoom, and
    /// the texture's format and level layout for `queue.writeTexture`.
    #[wasm_bindgen(getter)]
    pub fn meta(&self) -> String {
        self.meta.clone()
    }

    /// The vertex block, 16-byte vertices as stored, in a fresh JS buffer.
    #[wasm_bindgen(js_name = takeVertices)]
    pub fn take_vertices(&mut self) -> js_sys::Uint8Array {
        let array = js_sys::Uint8Array::from(&self.bytes[self.vertices.clone()]);
        self.vertices = 0..0;
        self.release();
        array
    }

    /// The index block, `u32` triangle list, in a fresh JS buffer.
    #[wasm_bindgen(js_name = takeIndices)]
    pub fn take_indices(&mut self) -> js_sys::Uint32Array {
        // The tile's bytes need not lie on a 4-byte boundary in Wasm memory:
        // the block is copied byte for byte into the new array's buffer.
        let array = js_sys::Uint32Array::new_with_length((self.indices.len() / 4) as u32);
        js_sys::Uint8Array::new(&array.buffer()).copy_from(&self.bytes[self.indices.clone()]);
        self.indices = 0..0;
        self.release();
        array
    }

    /// The texture array, every layer of every level in the order of the
    /// meta's levels, in a fresh JS buffer.
    #[wasm_bindgen(js_name = takeTexture)]
    pub fn take_texture(&mut self) -> js_sys::Uint8Array {
        let array = match &self.texture {
            TextureBytes::Stored(range) => js_sys::Uint8Array::from(&self.bytes[range.clone()]),
            TextureBytes::Decoded(pixels) => js_sys::Uint8Array::from(&pixels[..]),
        };
        self.texture = TextureBytes::Stored(0..0);
        self.release();
        array
    }

    /// Frees the tile's bytes once every block is taken.
    fn release(&mut self) {
        let texture_taken = matches!(&self.texture, TextureBytes::Stored(range) if range.is_empty());
        if self.vertices.is_empty() && self.indices.is_empty() && texture_taken {
            self.bytes = Vec::new();
        }
    }
}
