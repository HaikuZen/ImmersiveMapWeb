// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

//! B10, the CPU candidate: the occlusion of the sky by the terrain,
//! computed from a terrain tile's own heights, a port of the Swift
//! `GroundReliefOcclusion` that lost to the compute shader the engine
//! runs (docs/benchmarks/B10-occlusion.md). Kept for the benchmark and
//! as the reference the shader's bytes are checked against: for a grid of
//! `resolution` points a side over the tile, the mean over `directions`
//! directions of the sine of the horizon's elevation, the steepest line of
//! sight to the terrain out to the radius. Level ground and a summit see
//! the whole sky and get 0, the floor of a gorge sees little of it and
//! gets close to 1. Kept as bytes, 255 for 1, for an `r8unorm` texture.
//!
//! The terrain is read within the tile alone: a ridge just across the
//! tile's edge is not seen from a point near the edge.

use ground_relief::f32_from_f16_bits;

/// What a tile's occlusion is computed with: the same key, the same bytes.
/// A style that darkens nothing has a resolution of 0, and nothing is
/// computed for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Key {
    pub radius_metres: f32,
    pub directions: usize,
    pub resolution: usize,
}

impl Key {
    /// The key clamped as Swift clamps it: no negative or infinite radius,
    /// 4 to 32 directions, a resolution of 0 (off) or 16 to 1024.
    pub fn new(radius_metres: f32, directions: i32, resolution: i32) -> Key {
        Key {
            radius_metres: if radius_metres.is_finite() { radius_metres.max(0.0) } else { 0.0 },
            directions: directions.clamp(4, 32) as usize,
            resolution: if resolution <= 0 { 0 } else { resolution.clamp(16, 1024) as usize },
        }
    }

    /// Whether anything is computed under this key.
    pub fn computes(&self) -> bool {
        self.resolution > 0 && self.radius_metres > 0.0
    }
}

/// The ground metres a texel of a terrain tile of `size` texels a side
/// spans, at the tile's middle latitude.
pub fn metres_per_texel(z: u32, y: u32, size: usize) -> f32 {
    let count = 2f64.powi(z as i32);
    let middle_y = ((y as f64 + 0.5) / count).clamp(0.0, 1.0);
    let latitude = 2.0 * ((1.0 - 2.0 * middle_y) * std::f64::consts::PI).exp().atan() - std::f64::consts::FRAC_PI_2;
    let side_metres = 2.0 * std::f64::consts::PI * 6_378_137.0 * latitude.cos() / count;
    (side_metres / size.max(1) as f64) as f32
}

/// The distances the lines of sight step out at, in texels: every texel
/// near, then growing by a quarter each step, out to the radius.
pub fn steps(radius_texels: f32) -> Vec<f32> {
    let mut steps = Vec::new();
    let mut distance: f32 = 1.0;
    while distance <= radius_texels {
        steps.push(distance);
        distance = (distance + 1.0).max((distance * 1.25).floor());
    }
    steps
}

/// The lines of sight as texel offsets, direction by direction, step by
/// step, with one over the ground metres of each step.
pub struct Rays {
    pub offset_x: Vec<i32>,
    pub offset_y: Vec<i32>,
    pub inverse_metres: Vec<f32>,
    /// The steps of each direction.
    pub step_count: usize,
}

/// The rays of a key over texels of `metres_per_texel`.
pub fn rays(metres_per_texel: f32, key: &Key) -> Rays {
    let steps = steps(key.radius_metres / metres_per_texel);
    let capacity = key.directions * steps.len();
    let mut rays = Rays {
        offset_x: Vec::with_capacity(capacity),
        offset_y: Vec::with_capacity(capacity),
        inverse_metres: Vec::with_capacity(capacity),
        step_count: steps.len(),
    };
    for index in 0..key.directions {
        let angle = 2.0 * std::f32::consts::PI * index as f32 / key.directions as f32;
        let (x, y) = (angle.cos(), angle.sin());
        for &distance in &steps {
            // Rounded half away from zero, as Swift's `rounded()`.
            rays.offset_x.push((x * distance).round() as i32);
            rays.offset_y.push((y * distance).round() as i32);
            rays.inverse_metres.push(1.0 / (distance * metres_per_texel));
        }
    }
    rays
}

/// The occlusion over a tile, `key.resolution` squared bytes, row 0 at the
/// north edge as the heights are. `halves` are the tile's heights as half
/// floats, `size` a side.
pub fn compute(halves: &[u16], size: usize, metres_per_texel: f32, key: &Key) -> Vec<u8> {
    let resolution = key.resolution;
    let mut result = vec![0u8; resolution * resolution];
    if !key.computes() || size <= 1 || metres_per_texel <= 0.0 || halves.len() != size * size {
        return result;
    }
    let heights: Vec<f32> = halves.iter().map(|&h| f32_from_f16_bits(h)).collect();
    let rays = rays(metres_per_texel, key);
    let step_count = rays.step_count;
    if step_count == 0 {
        return result;
    }
    let share = 255.0 / key.directions as f32;
    let side = size as i32;
    for row in 0..resolution {
        let y = ((row as f32 + 0.5) * size as f32 / resolution as f32) as i32;
        for column in 0..resolution {
            let x = ((column as f32 + 0.5) * size as f32 / resolution as f32) as i32;
            let base = heights[(y * side + x) as usize];
            let mut sum: f32 = 0.0;
            for direction in 0..key.directions {
                let start = direction * step_count;
                let offset_x = &rays.offset_x[start..start + step_count];
                let offset_y = &rays.offset_y[start..start + step_count];
                let inverse_metres = &rays.inverse_metres[start..start + step_count];
                let mut steepest: f32 = 0.0;
                for step in 0..step_count {
                    let sample_x = x + offset_x[step];
                    let sample_y = y + offset_y[step];
                    if sample_x < 0 || sample_y < 0 || sample_x >= side || sample_y >= side {
                        break;
                    }
                    let slope = (heights[(sample_y * side + sample_x) as usize] - base) * inverse_metres[step];
                    if slope > steepest {
                        steepest = slope;
                    }
                }
                sum += steepest / (1.0 + steepest * steepest).sqrt();
            }
            result[row * resolution + column] = (sum * share).round().clamp(0.0, 255.0) as u8;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use ground_relief::f16_bits;

    /// A tile of `size` texels a side at `metres` everywhere, with the
    /// square from `block.0` to `block.1` (exclusive) at `block_metres`.
    fn halves(size: usize, metres: f32, block: Option<(usize, usize)>, block_metres: f32) -> Vec<u16> {
        let mut result = vec![f16_bits(metres); size * size];
        if let Some((from, to)) = block {
            for y in from..to {
                for x in from..to {
                    result[y * size + x] = f16_bits(block_metres);
                }
            }
        }
        result
    }

    #[test]
    fn the_key_clamps_and_a_style_off_computes_nothing() {
        let key = Key::new(-5.0, 1, 4);
        assert_eq!(key.radius_metres, 0.0);
        assert_eq!(key.directions, 4);
        assert_eq!(key.resolution, 16);
        assert!(!key.computes(), "No radius, nothing to look at");
        assert!(!Key::new(3000.0, 8, 0).computes(), "A style off has a resolution of 0");
        assert!(!Key::new(f32::INFINITY, 8, 128).computes());
        assert_eq!(Key::new(10.0, 99, 5000), Key { radius_metres: 10.0, directions: 32, resolution: 1024 });
        let on = Key::new(3000.0, 8, 128);
        assert_eq!((on.resolution, on.directions, on.radius_metres), (128, 8, 3000.0));
        assert!(on.computes());
    }

    #[test]
    fn a_texel_spans_the_tiles_side_over_its_texels() {
        let equator = metres_per_texel(0, 0, 512);
        assert!((equator - 40_075_017.0 / 512.0).abs() < 100.0, "The world's circumference over the texels at the equator");
        let zoom10 = metres_per_texel(10, 385, 512);
        let expected = 40_075_017.0 / 1024.0 / 512.0 * (41.2f32 * std::f32::consts::PI / 180.0).cos();
        assert!((zoom10 - expected).abs() < 1.0, "At the tile's own latitude: {zoom10} against {expected}");
    }

    #[test]
    fn the_steps_grow_out_to_the_radius() {
        let steps = steps(20.0);
        assert_eq!(steps[0], 1.0);
        assert_eq!(steps[..5], [1.0, 2.0, 3.0, 4.0, 5.0], "Every texel near");
        assert!(*steps.last().unwrap() <= 20.0);
        assert!(*steps.last().unwrap() > 15.0);
        assert!(steps.windows(2).all(|w| w[1] > w[0]));
        assert!(super::steps(0.5).is_empty());
    }

    #[test]
    fn a_plain_and_a_summit_see_the_whole_sky() {
        let key = Key::new(1000.0, 8, 16);
        let plain = compute(&halves(64, 500.0, None, 0.0), 64, 30.0, &key);
        assert_eq!(plain.len(), 16 * 16);
        assert!(plain.iter().all(|&v| v == 0), "Level ground is open to the sky");
        // A plateau in the middle: its top is a summit, open to the sky.
        let plateau = compute(&halves(64, 0.0, Some((24, 40)), 2000.0), 64, 30.0, &key);
        assert_eq!(plateau[8 * 16 + 8], 0, "The top of the plateau sees the whole sky");
        assert!(plateau[8 * 16 + 4] > 50, "The foot of its wall loses the sky on the wall's side");
    }

    #[test]
    fn the_floor_of_a_hole_is_occluded_and_the_radius_bounds_the_look() {
        let size = 64;
        // A plain at 2000 m with a hole of 0 m in the middle, 16 texels across.
        let hole = halves(size, 2000.0, Some((24, 40)), 0.0);
        let occluded = compute(&hole, size, 30.0, &Key::new(3000.0, 8, 16));
        let centre = occluded[8 * 16 + 8];
        assert!(centre > 200, "Walls of 2000 m a few hundred metres away hide most of the sky: {centre}");
        assert_eq!(occluded[16 + 1], 0, "The plain far from the hole sees the whole sky");
        assert!((occluded[8 * 16 + 7] as i32 - centre as i32).abs() <= 40, "About the same across the floor");
        // A radius shorter than the distance to the walls sees no wall.
        let unseen = compute(&hole, size, 30.0, &Key::new(100.0, 8, 16));
        assert_eq!(unseen[8 * 16 + 8], 0, "The walls are 240 m away, past the radius");
        // More directions, the same answer within the sampling.
        let smooth = compute(&hole, size, 30.0, &Key::new(3000.0, 32, 16));
        assert!((smooth[8 * 16 + 8] as i32 - centre as i32).abs() <= 30);
    }

    #[test]
    fn a_key_that_computes_nothing_or_heights_of_another_size_give_zeros() {
        let flat = halves(64, 0.0, Some((24, 40)), 2000.0);
        assert!(compute(&flat, 64, 30.0, &Key::new(0.0, 8, 16)).iter().all(|&v| v == 0));
        assert!(compute(&flat, 64, 30.0, &Key::new(3000.0, 8, 0)).is_empty());
        assert_eq!(compute(&flat[1..], 64, 30.0, &Key::new(3000.0, 8, 16)), vec![0; 256]);
        assert_eq!(compute(&flat, 64, 30.0, &Key::new(10.0, 8, 16)), vec![0; 256], "A radius under one texel has no steps");
    }

    #[test]
    fn the_rays_round_their_offsets_half_away_from_zero() {
        let rays = rays(1.0, &Key::new(2.0, 4, 16));
        assert_eq!(rays.step_count, 2);
        // East, south (row down), west, north, one and two texels out.
        assert_eq!(rays.offset_x, [1, 2, 0, 0, -1, -2, 0, 0]);
        assert_eq!(rays.offset_y, [0, 0, 1, 2, 0, 0, -1, -2]);
        assert_eq!(rays.inverse_metres, [1.0, 0.5, 1.0, 0.5, 1.0, 0.5, 1.0, 0.5]);
        let diagonal = super::rays(1.0, &Key::new(2.0, 8, 16));
        // 0.7071 rounds to 1, 1.414 to 1, and -0.7071 to -1, away from zero.
        assert_eq!(diagonal.offset_x[2..4], [1, 1]);
        assert_eq!(diagonal.offset_x[6..8], [-1, -1]);
    }
}
