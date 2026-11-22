// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! B18b: the layers' lines as ribbons the worker triangulates, against the
//! instance per segment the layers ship (crates/layer-mesh). The ribbon keeps
//! the look of the instance: each segment is its body and, at an end that is
//! round, half an octagon, all of it widened on screen in points, so every
//! vertex carries both ends of its segment and which corner it is. A flat
//! end (where a long segment was cut to follow the sphere) has no cap
//! vertices at all, where the instance draws its empty triangles.

use layer_mesh::content::{LayerStyles, SourceView};
use layer_mesh::mesh::{self, LineSegment, ROUND_END, ROUND_START};
use layer_mesh::mesh_file;

/// One ribbon vertex: the segment's start and end, its width in points, its
/// colour's red, green and blue and the corner (0 to 9, the corners of
/// layers.wgsl). 24 bytes.
pub const RIBBON_VERTEX_STRIDE: usize = 24;

/// The body's triangles over the corners, then the start's cap, then the end's.
const BODY: [u8; 6] = [0, 1, 5, 5, 1, 6];
const START_CAP: [u8; 9] = [0, 2, 4, 0, 4, 3, 0, 3, 1];
const END_CAP: [u8; 9] = [5, 7, 9, 5, 9, 8, 5, 8, 6];

/// The ribbons of `segments`: the vertex bytes and the u32 indices.
pub fn ribbons(segments: &[LineSegment]) -> (Vec<u8>, Vec<u32>) {
    let mut vertices: Vec<u8> = Vec::with_capacity(segments.len() * 10 * RIBBON_VERTEX_STRIDE);
    let mut indices: Vec<u32> = Vec::with_capacity(segments.len() * 24);
    let mut vertex_count = 0u32;
    for segment in segments {
        let flags = segment.color[3];
        let round_start = flags & ROUND_START != 0;
        let round_end = flags & ROUND_END != 0;
        // The corners this segment has, and each corner's vertex.
        let mut slot = [u32::MAX; 10];
        for corner in 0u8..10 {
            let is_start_cap = (2..5).contains(&corner);
            let is_end_cap = corner >= 7;
            if (is_start_cap && !round_start) || (is_end_cap && !round_end) {
                continue;
            }
            slot[corner as usize] = vertex_count;
            vertex_count += 1;
            for v in [segment.start[0], segment.start[1], segment.end[0], segment.end[1], segment.width_points] {
                vertices.extend_from_slice(&v.to_le_bytes());
            }
            vertices.extend_from_slice(&[segment.color[0], segment.color[1], segment.color[2], corner]);
        }
        indices.extend(BODY.iter().map(|&c| slot[c as usize]));
        if round_start {
            indices.extend(START_CAP.iter().map(|&c| slot[c as usize]));
        }
        if round_end {
            indices.extend(END_CAP.iter().map(|&c| slot[c as usize]));
        }
    }
    (vertices, indices)
}

/// The full path of the triangulated variant, what the layers' worker would
/// run in place of `buildMesh`: the mesh built, its lines turned into
/// ribbons and the whole written out. The bytes are the mesh file without its
/// segments (the zones, the discs, the chunks), then the ribbon vertices,
/// then the indices, after a header of three u32: the file's size, the
/// vertex bytes and the index count.
pub fn build_ribbon_mesh(source: &SourceView<'_>, styles: &LayerStyles) -> Vec<u8> {
    let mut data = mesh::build(source, styles);
    let (vertices, indices) = ribbons(&data.line_segments);
    data.line_segments.clear();
    let file = mesh_file::encode(&data);
    let mut out = Vec::with_capacity(12 + file.len() + vertices.len() + indices.len() * 4);
    for v in [file.len() as u32, vertices.len() as u32, indices.len() as u32] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&file);
    out.extend_from_slice(&vertices);
    for index in indices {
        out.extend_from_slice(&index.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(flags: u8) -> LineSegment {
        LineSegment { start: [0.0, 0.0], end: [10.0, 0.0], width_points: 4.0, color: [10, 20, 30, flags] }
    }

    #[test]
    fn a_round_segment_has_ten_corners_and_eight_triangles() {
        let (vertices, indices) = ribbons(&[segment(ROUND_START | ROUND_END)]);
        assert_eq!(vertices.len(), 10 * RIBBON_VERTEX_STRIDE);
        assert_eq!(indices.len(), 24);
        assert!(indices.iter().all(|&i| i < 10));
    }

    #[test]
    fn a_flat_segment_is_its_body_alone() {
        let (vertices, indices) = ribbons(&[segment(0), segment(ROUND_END)]);
        assert_eq!(vertices.len(), (4 + 7) * RIBBON_VERTEX_STRIDE);
        assert_eq!(indices.len(), 6 + 15);
        // The second segment's indices start past the first one's four vertices.
        assert_eq!(&indices[6..12], &[4, 5, 6, 6, 5, 7]);
        // The corner byte of the second segment's last vertex is the end cap's apex.
        assert_eq!(vertices[11 * RIBBON_VERTEX_STRIDE - 1], 9);
    }
}
