// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The terrain tiles a worker decodes (crates/ground-relief, decision B9):
//! the image's bytes to the half floats of the relief's `r16float`
//! texture and their height range. The worker's TypeScript fetches the
//! image. The occlusion of the sky is computed on the GPU from the
//! texture (decision B10), not here.

use ground_relief::{Encoding, decode, halves, height_range};
use wasm_bindgen::prelude::*;

/// A terrain tile decoded.
#[wasm_bindgen]
pub struct DecodedTerrain {
    size: u32,
    halves: Vec<u16>,
    #[wasm_bindgen(js_name = minMetres)]
    pub min_metres: f32,
    #[wasm_bindgen(js_name = maxMetres)]
    pub max_metres: f32,
}

#[wasm_bindgen]
impl DecodedTerrain {
    /// The texels a side.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.size
    }

    /// The heights as half floats' bits, `size` squared, row 0 north,
    /// copied into a fresh JS buffer the worker transfers. The tile keeps
    /// none after.
    #[wasm_bindgen(js_name = takeHalves)]
    pub fn take_halves(&mut self) -> js_sys::Uint16Array {
        let array = js_sys::Uint16Array::from(&self.halves[..]);
        self.halves = Vec::new();
        array
    }
}

/// Decodes a terrain tile, a PNG or a WebP, in an encoding: 0 Terrarium,
/// 1 Mapbox. Throws for an image that does not decode or is not square,
/// which the worker answers as a tile the source does not have.
#[wasm_bindgen(js_name = decodeTerrainTile)]
pub fn decode_terrain_tile(bytes: &[u8], encoding: u8) -> Result<DecodedTerrain, JsError> {
    let encoding = if encoding == 1 { Encoding::Mapbox } else { Encoding::Terrarium };
    let heights = decode(bytes, encoding).map_err(|e| JsError::new(&e.to_string()))?;
    let (min_metres, max_metres) = height_range(&heights.metres);
    Ok(DecodedTerrain { size: heights.size as u32, halves: halves(&heights.metres), min_metres, max_metres })
}
