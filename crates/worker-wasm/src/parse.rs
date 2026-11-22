// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The tile parser a worker runs: the full Swift-engine parse
//! (crates/tile-parse) behind one call that takes a tile's MVT bytes and
//! returns its GPU arena and the metadata JSON beside it. The labels are
//! laid out with the atlases bundled in `text-layout`, the package's own.

use std::collections::BTreeMap;

use map_style::adaptation::{GlyphCoverage, TileLabelDecisions};
use map_style::style::default::{ProtomapsBasemapMapStyle, ProtomapsBasemapTheme};
use map_style::style::{AnyMapStyle, MapStyleRuntime};
use map_style::support::{LabelFallbackPolicy, LabelLanguage};
use serde::{Deserialize, Serialize};
use tile_parse::options::TileParseOptions;
use tile_parse::parser::TileMvtParser;
use tile_parse::tile::Tile;
use tile_parse::unification::TileArenaMeta;
use wasm_bindgen::prelude::*;

/// What a worker is configured with, as JSON (camelCase).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ParserConfig {
    /// "light" or "night": the built-in palette the theme starts from.
    palette: String,
    /// A whole theme, in place of the palette's.
    theme: Option<ProtomapsBasemapTheme>,
    language: LabelLanguage,
    fallback_policy: LabelFallbackPolicy,
    /// The code points the label atlases carry.
    glyphs: Vec<u32>,
    options: OptionsConfig,
}

impl Default for ParserConfig {
    fn default() -> Self {
        ParserConfig { palette: "light".into(), theme: None, language: LabelLanguage::default(), fallback_policy: LabelFallbackPolicy::default(), glyphs: Vec::new(), options: OptionsConfig::default() }
    }
}

/// `TileParseOptions` as the settings tree states it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct OptionsConfig {
    labels_enabled: bool,
    add_test_borders: bool,
    building_minimum_source_zoom: i32,
    building_deepest_source_zoom: Option<i32>,
    ground_flattening_from_tile_zoom: Option<i32>,
    ground_flattening_grid: i32,
    ground_flattening_grid_by_tile_zoom: BTreeMap<String, i32>,
    ground_relief_enabled: bool,
    tree_minimum_source_zoom: Option<i32>,
    tree_maximum_per_tile: i32,
}

impl Default for OptionsConfig {
    fn default() -> Self {
        let basic = TileParseOptions::basic(true, 14);
        OptionsConfig {
            labels_enabled: basic.labels_enabled,
            add_test_borders: basic.add_test_borders,
            building_minimum_source_zoom: basic.building_minimum_source_zoom,
            building_deepest_source_zoom: basic.building_deepest_source_zoom,
            ground_flattening_from_tile_zoom: basic.ground_flattening_from_tile_zoom,
            ground_flattening_grid: basic.ground_flattening_grid,
            ground_flattening_grid_by_tile_zoom: basic.ground_flattening_grid_by_tile_zoom.iter().map(|(z, g)| (z.to_string(), *g)).collect(),
            ground_relief_enabled: basic.ground_relief_enabled,
            tree_minimum_source_zoom: basic.tree_minimum_source_zoom,
            tree_maximum_per_tile: basic.tree_maximum_per_tile,
        }
    }
}

impl OptionsConfig {
    fn build(self) -> Result<TileParseOptions, String> {
        let mut grids = BTreeMap::new();
        for (zoom, grid) in self.ground_flattening_grid_by_tile_zoom {
            grids.insert(zoom.parse::<i32>().map_err(|_| format!("groundFlatteningGridByTileZoom: {zoom} is not a zoom"))?, grid);
        }
        Ok(TileParseOptions::new(
            self.labels_enabled,
            self.add_test_borders,
            self.building_minimum_source_zoom,
            self.building_deepest_source_zoom,
            self.ground_flattening_from_tile_zoom,
            self.ground_flattening_grid,
            grids,
            self.ground_relief_enabled,
            self.tree_minimum_source_zoom,
            self.tree_maximum_per_tile,
        ))
    }
}

/// The metadata beside the arena: the arena's own, its labels among it,
/// and what the planners read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetaOut<'a> {
    #[serde(flatten)]
    arena: &'a TileArenaMeta,
    ground_is_flattened: bool,
}

#[wasm_bindgen]
pub struct TileParser {
    parser: TileMvtParser,
    revision: u32,
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
    /// `config` is the JSON of `ParserConfig`. An empty string takes every default.
    #[wasm_bindgen(constructor)]
    pub fn new(config: &str) -> Result<TileParser, JsError> {
        let config: ParserConfig = if config.trim().is_empty() { ParserConfig::default() } else { serde_json::from_str(config).map_err(|e| JsError::new(&format!("parser config: {e}")))? };
        let style = match (config.theme, config.palette.as_str()) {
            (Some(theme), _) => ProtomapsBasemapMapStyle::new(theme),
            (None, "night") => ProtomapsBasemapMapStyle::night(),
            (None, _) => ProtomapsBasemapMapStyle::default(),
        };
        let runtime = MapStyleRuntime::new(&AnyMapStyle::new(&style));
        let decisions = TileLabelDecisions::new(runtime.style.as_ref(), GlyphCoverage::new(config.glyphs), &config.language, config.fallback_policy);
        let options = config.options.build().map_err(|e| JsError::new(&e))?;
        let revision = runtime.prepared_tile_style_revision();
        Ok(TileParser { parser: TileMvtParser::new(runtime, decisions, options), revision })
    }

    /// The version of the prepared arena format: part of the disk cache's identity.
    #[wasm_bindgen(getter, js_name = formatVersion)]
    pub fn format_version(&self) -> u32 {
        tile_parse::unification::PREPARED_FORMAT_VERSION
    }

    /// The revision of how label text is laid out into a prepared tile, the
    /// bundled atlases included: part of the disk cache's identity.
    #[wasm_bindgen(getter, js_name = textRevision)]
    pub fn text_revision(&self) -> u32 {
        text_layout::PREPARED_TILE_TEXT_REVISION
    }

    /// The revision of what the style bakes into a prepared tile: part of the disk cache's identity.
    #[wasm_bindgen(getter, js_name = styleRevision)]
    pub fn style_revision(&self) -> u32 {
        self.revision
    }

    pub fn parse(&self, mvt: &[u8], z: i32, x: i32, y: i32) -> Result<ParsedTile, JsError> {
        let prepared = self.parser.parse(Tile { x, y, z }, mvt).map_err(|e| JsError::new(&format!("{e:?}")))?;
        let meta = MetaOut { arena: &prepared.meta, ground_is_flattened: prepared.result.ground_is_flattened };
        let meta = serde_json::to_string(&meta).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(ParsedTile { arena: prepared.arena, meta })
    }
}
