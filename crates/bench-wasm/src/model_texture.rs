// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! B14, the BC7 candidate for a GPU without ASTC: a model tile's texture
//! block, ASTC as the archive stores it, decoded to RGBA8 (the decoder the
//! model worker ships, crates/model-tile) and encoded again as BC7
//! (`texture-compressor`, MIT or Apache-2.0), every layer of every level in
//! the stored order. Nothing here ships: the encoder stays out of the model
//! worker's module unless the measurement picks it.

use astc_decode::{Footprint, astc_decode_block};
use model_tile::astc::decode_rgba8;
use model_tile::contents::Texture;
use texture_compressor::{Effort, Format, ImageView, Settings, encode_into, encoded_len};
use wasm_bindgen::prelude::*;

/// The texture block of a tile (`blocks`) as the header describes it, to
/// BC7 with the fast preset: level 0 first, all layers of a level, then
/// the next level, a level of `w` by `h` pixels in `ceil(w / 4) *
/// ceil(h / 4)` blocks of 16 bytes a layer. The result is copied out once.
#[wasm_bindgen(js_name = astcToBc7)]
pub fn astc_to_bc7(
    blocks: &[u8],
    width: u32,
    height: u32,
    mip_level_count: u32,
    layer_count: u32,
    block_edge: u32,
) -> Result<js_sys::Uint8Array, JsError> {
    let texture = Texture {
        width: width as usize,
        height: height as usize,
        mip_level_count: mip_level_count as usize,
        block_edge: block_edge as usize,
        layer_count: layer_count as usize,
    };
    let pixels = decode_rgba8(&texture, blocks).map_err(|e| JsError::new(&e.to_string()))?;
    let settings = Settings::new(Format::Bc7, Effort::Fast);
    let error = |e: texture_compressor::Error| JsError::new(&format!("{e:?}"));
    let mut lengths = Vec::new();
    for level in 0..texture.mip_level_count {
        let (w, h) = texture.level_size(level);
        lengths.push(encoded_len(Format::Bc7, w as u32, h as u32).map_err(error)?);
    }
    let mut out = vec![0; lengths.iter().sum::<usize>() * texture.layer_count];
    let (mut source, mut target) = (0, 0);
    for (level, length) in lengths.iter().enumerate() {
        let (w, h) = texture.level_size(level);
        for _ in 0..texture.layer_count {
            let image = ImageView::rgba8(&pixels[source..source + w * h * 4], w as u32, h as u32, w * 4).map_err(error)?;
            encode_into(image, &settings, &mut out[target..target + length]).map_err(error)?;
            source += w * h * 4;
            target += length;
        }
    }
    Ok(js_sys::Uint8Array::from(&out[..]))
}

/// `count` ASTC blocks of an `edge` by `edge` footprint that the decoder
/// takes as legal and that are not void extent, drawn from a seeded
/// generator: the stand-in for a photographic texture, since the published
/// archive's textures are swatches of one colour a block (void extent).
/// Random legal blocks spread over every block mode, partition count and
/// endpoint mode, so they cost the decoder at least what an image does and
/// are the hardest input for the BC7 encoder.
#[wasm_bindgen(js_name = legalAstcBlocks)]
pub fn legal_astc_blocks(count: u32, edge: u32, seed: u32) -> Vec<u8> {
    legal_blocks(count as usize, edge, seed)
}

fn legal_blocks(count: usize, edge: u32, seed: u32) -> Vec<u8> {
    let footprint = Footprint::new(edge, edge);
    let mut state = u64::from(seed) | 1 << 40;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut out = Vec::with_capacity(count * 16);
    while out.len() < count * 16 {
        let mut block = [0u8; 16];
        block[..8].copy_from_slice(&next().to_le_bytes());
        block[8..].copy_from_slice(&next().to_le_bytes());
        let is_void_extent = block[0] == 0xFC && block[1] & 0x01 == 0x01;
        if !is_void_extent && astc_decode_block(&block, footprint, |_, _, _| {}) {
            out.extend_from_slice(&block);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_legal_blocks_decode_and_vary() {
        let blocks = legal_blocks(256, 8, 7);
        assert_eq!(blocks.len(), 256 * 16);
        let mut colours = std::collections::HashSet::new();
        for block in blocks.as_chunks::<16>().0 {
            assert!(astc_decode_block(block, Footprint::new(8, 8), |_, _, colour| {
                colours.insert(colour);
            }));
        }
        assert!(colours.len() > 1000, "{} colours", colours.len());
    }
}
