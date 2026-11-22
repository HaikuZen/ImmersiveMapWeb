// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! Wasm entry points that exist only to be measured against the browser's
//! own implementations (docs/benchmarks). Nothing here ships in the library.

use std::io::Read;

use wasm_bindgen::prelude::*;

mod layer_ribbons;
mod model_texture;
mod occlusion;


/// Skips a gzip member's header (RFC 1952) and returns the offset of the
/// deflate stream.
fn gzip_body_offset(bytes: &[u8]) -> Result<usize, JsError> {
    if bytes.len() < 18 || bytes[0] != 0x1f || bytes[1] != 0x8b || bytes[2] != 8 {
        return Err(JsError::new("not a gzip member"));
    }
    let flags = bytes[3];
    let mut offset = 10;
    if flags & 0x04 != 0 {
        let extra = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset += 2 + extra;
    }
    for flag in [0x08, 0x10] {
        if flags & flag != 0 {
            while offset < bytes.len() && bytes[offset] != 0 {
                offset += 1;
            }
            offset += 1;
        }
    }
    if flags & 0x02 != 0 {
        offset += 2;
    }
    Ok(offset)
}

/// The size of the inflated member, from the gzip trailer (ISIZE).
fn gzip_inflated_size(bytes: &[u8]) -> usize {
    let n = bytes.len();
    u32::from_le_bytes([bytes[n - 4], bytes[n - 3], bytes[n - 2], bytes[n - 1]]) as usize
}

/// Inflates a gzip member with miniz_oxide, returning the inflated length
/// (the bytes stay in Wasm memory, as a Wasm parser would read them).
#[wasm_bindgen(js_name = inflateMiniz)]
pub fn inflate_miniz(bytes: &[u8]) -> Result<usize, JsError> {
    let body = gzip_body_offset(bytes)?;
    let out = miniz_oxide::inflate::decompress_to_vec_with_limit(&bytes[body..bytes.len() - 8], 64 << 20)
        .map_err(|e| JsError::new(&format!("{e:?}")))?;
    Ok(out.len())
}

/// The same with zlib-rs through flate2.
#[wasm_bindgen(js_name = inflateZlibRs)]
pub fn inflate_zlib_rs(bytes: &[u8]) -> Result<usize, JsError> {
    let mut out = Vec::with_capacity(gzip_inflated_size(bytes));
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut out).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(out.len())
}

/// miniz_oxide, then the inflated bytes copied out to a JS array, the path
/// for bytes a JS consumer reads.
#[wasm_bindgen(js_name = inflateMinizToJs)]
pub fn inflate_miniz_to_js(bytes: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
    let body = gzip_body_offset(bytes)?;
    let out = miniz_oxide::inflate::decompress_to_vec_with_limit(&bytes[body..bytes.len() - 8], 64 << 20)
        .map_err(|e| JsError::new(&format!("{e:?}")))?;
    Ok(js_sys::Uint8Array::from(&out[..]))
}

/// Takes bytes into Wasm memory and does nothing with them: the copy a
/// JS-side inflate pays before a Wasm parser can read its output.
#[wasm_bindgen(js_name = copyIn)]
pub fn copy_in(bytes: &[u8]) -> usize {
    bytes.len()
}

/// B9: a terrain tile (Terrarium-encoded WebP) to heights in metres, decoded
/// in Wasm by the engine's decoder (crates/ground-relief, image-webp).
#[wasm_bindgen(js_name = decodeTerrariumWebp)]
pub fn decode_terrarium_webp(bytes: &[u8]) -> Result<js_sys::Float32Array, JsError> {
    let heights = ground_relief::decode(bytes, ground_relief::Encoding::Terrarium).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(js_sys::Float32Array::from(&heights.metres[..]))
}

/// B10: the occlusion of a terrain tile on the CPU from its halves handed
/// in from JavaScript (copied into Wasm, the bytes out), under the key
/// clamped as Swift clamps it. Empty when the key computes nothing.
#[wasm_bindgen(js_name = terrainOcclusion)]
pub fn terrain_occlusion(halves: &[u16], size: u32, z: u32, y: u32, radius_metres: f32, directions: i32, resolution: i32) -> js_sys::Uint8Array {
    let key = occlusion::Key::new(radius_metres, directions, resolution);
    if !key.computes() {
        return js_sys::Uint8Array::new_with_length(0);
    }
    let size = size as usize;
    let bytes = occlusion::compute(halves, size, occlusion::metres_per_texel(z, y, size), &key);
    js_sys::Uint8Array::from(&bytes[..])
}

/// B10: a terrain tile decoded with its halves kept in Wasm, for the
/// occlusion computed beside the decode, with no copy in.
#[wasm_bindgen]
pub struct BenchTerrain {
    size: usize,
    halves: Vec<u16>,
}

#[wasm_bindgen]
impl BenchTerrain {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<BenchTerrain, JsError> {
        let heights = ground_relief::decode(bytes, ground_relief::Encoding::Terrarium).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(BenchTerrain { size: heights.size, halves: ground_relief::halves(&heights.metres) })
    }

    #[wasm_bindgen(js_name = computeOcclusion)]
    pub fn compute_occlusion(&self, z: u32, y: u32, radius_metres: f32, directions: i32, resolution: i32) -> js_sys::Uint8Array {
        let key = occlusion::Key::new(radius_metres, directions, resolution);
        let bytes = occlusion::compute(&self.halves, self.size, occlusion::metres_per_texel(z, y, self.size), &key);
        js_sys::Uint8Array::from(&bytes[..])
    }
}

mod geojson {
    //! B11: a GeoJSON FeatureCollection parsed into flat coordinates and the
    //! features' properties, what the layers' tessellation reads.

    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct Collection {
        pub features: Vec<Feature>,
    }

    #[derive(Deserialize)]
    pub struct Feature {
        pub geometry: Geometry,
        #[serde(default)]
        pub properties: Option<serde_json::Map<String, serde_json::Value>>,
    }

    #[derive(Deserialize)]
    #[serde(tag = "type", content = "coordinates")]
    pub enum Geometry {
        Point([f64; 2]),
        MultiPoint(Vec<[f64; 2]>),
        LineString(Vec<[f64; 2]>),
        MultiLineString(Vec<Vec<[f64; 2]>>),
        Polygon(Vec<Vec<[f64; 2]>>),
        MultiPolygon(Vec<Vec<Vec<[f64; 2]>>>),
    }

    /// Every coordinate of the collection, x and y interleaved, and the property count.
    pub fn flatten(collection: &Collection) -> (Vec<f64>, usize) {
        let mut out = Vec::new();
        let mut properties = 0;
        let push = |p: &[f64; 2], out: &mut Vec<f64>| out.extend_from_slice(p);
        for f in &collection.features {
            properties += f.properties.as_ref().map_or(0, |p| p.len());
            match &f.geometry {
                Geometry::Point(p) => push(p, &mut out),
                Geometry::MultiPoint(l) | Geometry::LineString(l) => l.iter().for_each(|p| push(p, &mut out)),
                Geometry::MultiLineString(r) | Geometry::Polygon(r) => r.iter().flatten().for_each(|p| push(p, &mut out)),
                Geometry::MultiPolygon(m) => m.iter().flatten().flatten().for_each(|p| push(p, &mut out)),
            }
        }
        (out, properties)
    }
}

thread_local! {
    static KEPT: std::cell::RefCell<Vec<f64>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// B11: serde_json from the bytes. Returns the coordinate count, keeps the coordinates in Wasm.
#[wasm_bindgen(js_name = geojsonSerde)]
pub fn geojson_serde(bytes: &[u8]) -> Result<usize, JsError> {
    let collection: geojson::Collection = serde_json::from_slice(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    let (coordinates, _) = geojson::flatten(&collection);
    let n = coordinates.len();
    KEPT.with(|k| *k.borrow_mut() = coordinates);
    Ok(n)
}

/// B11: simd-json from the bytes (it parses in place, so it takes its own copy).
#[wasm_bindgen(js_name = geojsonSimd)]
pub fn geojson_simd(bytes: &[u8]) -> Result<usize, JsError> {
    let mut owned = bytes.to_vec();
    let collection: geojson::Collection = simd_json::serde::from_slice(&mut owned).map_err(|e| JsError::new(&e.to_string()))?;
    let (coordinates, _) = geojson::flatten(&collection);
    let n = coordinates.len();
    KEPT.with(|k| *k.borrow_mut() = coordinates);
    Ok(n)
}

/// B11: the coordinates JavaScript flattened after `JSON.parse`, copied in. Returns their count.
#[wasm_bindgen(js_name = keepCoordinates)]
pub fn keep_coordinates(coordinates: &[f64]) -> usize {
    KEPT.with(|k| *k.borrow_mut() = coordinates.to_vec());
    coordinates.len()
}

/// The Wasm memory's size, for the peak-memory column.
#[wasm_bindgen(js_name = wasmMemoryBytes)]
pub fn wasm_memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    return core::arch::wasm32::memory_size(0) * 65536;
    // A native build (the workspace checks) has no Wasm memory to report.
    #[cfg(not(target_arch = "wasm32"))]
    0
}


/// B18b: a layer's mesh with its lines as triangulated ribbons
/// (`layer_ribbons`), the same inputs as the layers' `buildMesh`.
#[wasm_bindgen(js_name = buildLayerRibbonMesh)]
pub fn build_layer_ribbon_mesh(coordinates: &[f64], polygons: &[u32], rings: &[u32], polylines: &[u32], points: &[u32], styles: &[f32], layer_styles: &[f32]) -> Vec<u8> {
    let source = layer_mesh::content::SourceView { coordinates, polygons, rings, polylines, points, styles };
    let styles = layer_mesh::content::LayerStyles::from_floats(layer_styles).unwrap_or_default();
    layer_ribbons::build_ribbon_mesh(&source, &styles)
}
