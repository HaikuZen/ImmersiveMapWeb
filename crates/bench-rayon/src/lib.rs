// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! B17: the tile parser over a rayon pool in one Wasm instance whose memory
//! is shared by its threads (wasm-bindgen-rayon, SharedArrayBuffer, which a
//! page may only use under COOP and COEP). The counterpart is several
//! workers, each with its own instance of the ordinary worker module.

use map_style::adaptation::{GlyphCoverage, TileLabelDecisions};
use map_style::style::default::ProtomapsBasemapMapStyle;
use map_style::style::{AnyMapStyle, MapStyleRuntime};
use map_style::support::{LabelFallbackPolicy, LabelLanguage};
use rayon::prelude::*;
use tile_parse::options::TileParseOptions;
use tile_parse::parser::TileMvtParser;
use tile_parse::tile::Tile;
use wasm_bindgen::prelude::*;

pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen]
pub struct PooledParser {
    parser: TileMvtParser,
}

#[wasm_bindgen]
impl PooledParser {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PooledParser {
        let style = MapStyleRuntime::new(&AnyMapStyle::new(&ProtomapsBasemapMapStyle::default()));
        let decisions = TileLabelDecisions::new(style.style.as_ref(), GlyphCoverage::new([]), &LabelLanguage::english(), LabelFallbackPolicy::International);
        PooledParser { parser: TileMvtParser::new(style, decisions, TileParseOptions::basic(true, 14)) }
    }

    /// Parses every tile across the pool: `bytes` is the tiles' inflated MVT
    /// concatenated, `ends` where each ends, `zxy` three ints per tile.
    /// Returns the total arena bytes, so nothing is optimised away.
    #[wasm_bindgen(js_name = parseAll)]
    pub fn parse_all(&self, bytes: &[u8], ends: &[u32], zxy: &[i32]) -> f64 {
        let ranges: Vec<(usize, usize, Tile)> = ends
            .iter()
            .enumerate()
            .map(|(i, &end)| {
                let start = if i == 0 { 0 } else { ends[i - 1] as usize };
                (start, end as usize, Tile::new(zxy[i * 3], zxy[i * 3 + 1], zxy[i * 3 + 2]))
            })
            .collect();
        ranges.par_iter().map(|&(s, e, tile)| self.parser.parse(tile, &bytes[s..e]).map_or(0, |p| p.arena.len()) as f64).sum()
    }
}

impl Default for PooledParser {
    fn default() -> Self {
        Self::new()
    }
}
