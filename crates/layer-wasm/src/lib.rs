// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! The Wasm entry of the layers' worker (crates/layer-mesh): a GeoJSON
//! document read into the flat shapes of a source, and a layer's mesh built
//! from flat shapes into the one buffer the main thread uploads and the disk
//! cache keeps. The worker runs on its own, so the map can end it after a
//! large parse and its memory goes back to the system.

use layer_mesh::content::{LayerStyles, SourceContent, SourceView};
use layer_mesh::geojson::{self, GeoJsonError};
use layer_mesh::{mesh, mesh_file};
use wasm_bindgen::prelude::*;

/// A parsed document: the source's flat arrays, or why it could not be read.
/// Each `take` hands its array over once and leaves it empty.
#[wasm_bindgen]
pub struct ParsedGeoJSON {
    content: SourceContent,
    error_kind: String,
    error_detail: String,
}

impl ParsedGeoJSON {
    fn from(outcome: Result<SourceContent, GeoJsonError>) -> ParsedGeoJSON {
        match outcome {
            Ok(content) => ParsedGeoJSON { content, error_kind: String::new(), error_detail: String::new() },
            Err(error) => {
                let (kind, detail) = match error {
                    GeoJsonError::InvalidJson => ("invalidJSON", String::new()),
                    GeoJsonError::UnknownType(t) => ("unknownType", t),
                    GeoJsonError::InvalidCoordinates(p) => ("invalidCoordinates", p),
                };
                ParsedGeoJSON { content: SourceContent::default(), error_kind: kind.to_owned(), error_detail: detail }
            }
        }
    }
}

#[wasm_bindgen]
impl ParsedGeoJSON {
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.error_kind.is_empty()
    }

    /// "invalidJSON", "unknownType" or "invalidCoordinates", empty when the document was read.
    #[wasm_bindgen(getter, js_name = errorKind)]
    pub fn error_kind(&self) -> String {
        self.error_kind.clone()
    }

    /// The unknown type or the path of the bad coordinates.
    #[wasm_bindgen(getter, js_name = errorDetail)]
    pub fn error_detail(&self) -> String {
        self.error_detail.clone()
    }

    #[wasm_bindgen(js_name = takeCoordinates)]
    pub fn take_coordinates(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.content.coordinates)
    }

    #[wasm_bindgen(js_name = takePolygons)]
    pub fn take_polygons(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.content.polygons)
    }

    #[wasm_bindgen(js_name = takeRings)]
    pub fn take_rings(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.content.rings)
    }

    #[wasm_bindgen(js_name = takePolylines)]
    pub fn take_polylines(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.content.polylines)
    }

    #[wasm_bindgen(js_name = takePoints)]
    pub fn take_points(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.content.points)
    }

    #[wasm_bindgen(js_name = takeIds)]
    pub fn take_ids(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.content.ids)
    }

    #[wasm_bindgen(js_name = takeStyles)]
    pub fn take_styles(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.content.styles)
    }
}

/// Reads a GeoJSON document from its UTF-8 bytes.
#[wasm_bindgen(js_name = parseGeoJSON)]
pub fn parse_geojson(bytes: &[u8]) -> ParsedGeoJSON {
    ParsedGeoJSON::from(geojson::parse(bytes))
}

/// Reads a GeoJSON document from a string.
#[wasm_bindgen(js_name = parseGeoJSONText)]
pub fn parse_geojson_text(text: &str) -> ParsedGeoJSON {
    ParsedGeoJSON::from(geojson::parse(text.as_bytes()))
}

/// The mesh of a layer of `layer_styles` (24 floats) drawing the flat
/// shapes given, as the mesh file's bytes. Fewer style floats draw in the
/// default styles.
#[wasm_bindgen(js_name = buildMesh)]
pub fn build_mesh(coordinates: &[f64], polygons: &[u32], rings: &[u32], polylines: &[u32], points: &[u32], styles: &[f32], layer_styles: &[f32]) -> Vec<u8> {
    let source = SourceView { coordinates, polygons, rings, polylines, points, styles };
    let styles = LayerStyles::from_floats(layer_styles).unwrap_or_default();
    mesh_file::encode(&mesh::build(&source, &styles))
}

/// The version of the mesh file this module writes.
#[wasm_bindgen(js_name = meshFileVersion)]
pub fn mesh_file_version() -> u32 {
    mesh_file::VERSION
}

/// The module's linear memory, in bytes: what the worker would give back when ended.
#[wasm_bindgen(js_name = wasmMemoryBytes)]
pub fn wasm_memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
