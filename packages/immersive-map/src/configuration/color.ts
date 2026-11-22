// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** A colour as red, green and blue in `0...1` (Swift's `SIMD3<Float>`). */
export type Rgb = readonly [number, number, number];

/** A colour as red, green, blue and alpha in `0...1` (Swift's `SIMD4<Float>`). */
export type Rgba = readonly [number, number, number, number];

/** A direction or a point in three dimensions (Swift's `SIMD3<Float>`). */
export type Vector3 = readonly [number, number, number];
