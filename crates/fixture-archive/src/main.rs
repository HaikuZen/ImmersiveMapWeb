// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! Packs the fixture tiles (fixtures/tiles/<z>-<x>-<y>.mvt.gz, as fetched by
//! scripts/fetch-fixtures.mjs) into fixtures/fixtures.pmtiles, the local
//! archive the smoke tests and the playground read with no network, and the
//! fixture model tiles (fixtures/models/<z>-<x>-<y>.immt, decompressed) into
//! fixtures/models.pmtiles, a local model archive of the same format as the
//! hosted one (gzip tiles, tile type unknown):
//!   cargo run -p fixture-archive

use std::fs;
use std::path::Path;

use pmtiles::{Compression, TileType, WriterTile, write_archive};

fn main() -> Result<(), String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut tiles = Vec::new();
    for entry in fs::read_dir(root.join("tiles")).map_err(|e| format!("fixtures/tiles: {e} (run scripts/fetch-fixtures.mjs)"))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let Some(stem) = name.strip_suffix(".mvt.gz") else { continue };
        let parts: Vec<u32> = stem.split('-').filter_map(|p| p.parse().ok()).collect();
        let [z, x, y] = parts[..] else { continue };
        tiles.push(WriterTile { z: z as u8, x, y, data: fs::read(&path).map_err(|e| e.to_string())? });
    }
    let count = tiles.len();
    let bytes = write_archive(tiles, Compression::Gzip, TileType::Mvt)?;
    fs::write(root.join("fixtures.pmtiles"), &bytes).map_err(|e| e.to_string())?;
    println!("fixtures/fixtures.pmtiles: {count} tiles, {} bytes", bytes.len());
    write_model_archive(&root)
}

/// The model tiles, gzipped as the hosted archive stores them. A fixture set
/// without model tiles writes no model archive.
fn write_model_archive(root: &Path) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(root.join("models")) else {
        println!("fixtures/models: absent, no model archive written");
        return Ok(());
    };
    let mut tiles = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let Some(stem) = name.strip_suffix(".immt") else { continue };
        let parts: Vec<u32> = stem.split('-').filter_map(|p| p.parse().ok()).collect();
        let [z, x, y] = parts[..] else { continue };
        tiles.push(WriterTile { z: z as u8, x, y, data: gzip(&fs::read(&path).map_err(|e| e.to_string())?)? });
    }
    let count = tiles.len();
    let bytes = write_archive(tiles, Compression::Gzip, TileType::Unknown)?;
    fs::write(root.join("models.pmtiles"), &bytes).map_err(|e| e.to_string())?;
    println!("fixtures/models.pmtiles: {count} model tiles, {} bytes", bytes.len());
    Ok(())
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}
