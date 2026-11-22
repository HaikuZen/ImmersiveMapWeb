// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** The marker of a WGSL line kept only where the device has `clip-distances`. */
export const CLIP_DISTANCES_MARKER = "// clip-distances";
/** The marker of a WGSL line kept only where it has not: the fragment discard by the interpolated clearance. */
export const NO_CLIP_DISTANCES_MARKER = "// no-clip-distances";

/**
 * The globe modules' source for a device: the unroll's cut is a clip
 * distance where the device has `clip-distances` (the Metal
 * `[[clip_distance]]`), and a discard by the same clearance, interpolated
 * the same way, where it has not. Each line that ends in the other
 * variant's marker is dropped (globe/shaders/clip-distances.wgsl).
 * scripts/check-shaders.mjs validates both variants by the same rule.
 */
export function clipDistanceVariant(source: string, clipDistances: boolean): string {
  const drop = clipDistances ? NO_CLIP_DISTANCES_MARKER : CLIP_DISTANCES_MARKER;
  return source
    .split("\n")
    .filter((line) => !line.trimEnd().endsWith(drop))
    .join("\n");
}
