// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GlobeUniform } from "./globe-uniform.ts";
import type { GlobeFrameConstants } from "./globe-frame-constants.ts";
import type { GlobeLight } from "./globe-light.ts";

/**
 * The globe's frame uniform, what every globe draw reads (binding 3 of the
 * tile pipelines' frame group): the Swift `Globe`, `GlobeFrameConstants`,
 * `GlobeLight` and `TileSphereHandoverUniform` in one buffer, written once a
 * frame. Mirrors `GlobeFrame` in globe.wgsl, pinned by its test:
 *
 * ```wgsl
 * struct GlobeFrame {
 *   sphereClip: mat4x4f,            // 0
 *   sphereWorld: mat4x4f,           // 64
 *   pan: vec2f,                     // 128
 *   radius: f32,                    // 136
 *   transition: f32,                // 140
 *   mapSize: f32,                   // 144
 *   panMercatorY: f32,              // 148
 *   handover: f32,                  // 152
 *   padding: f32,                   // 156
 *   lightAndStrength: vec4f,        // 160
 *   nightColorAndSoftness: vec4f,   // 176
 * }                                 // 192
 * ```
 *
 * The pan rotation itself stays on the CPU: no shader of the surface reads
 * it once the composed matrices carry it.
 */
export const GlobeFrameUniformLayout = {
  byteLength: 192,
  sphereClip: 0,
  sphereWorld: 64,
  pan: 128,
  radius: 136,
  transition: 140,
  mapSize: 144,
  panMercatorY: 148,
  handover: 152,
  lightAndStrength: 160,
  nightColorAndSoftness: 176,
} as const;

export interface GlobeFrameUniformInput {
  readonly globe: GlobeUniform;
  readonly constants: GlobeFrameConstants;
  readonly light: GlobeLight;
  /** How far the globe's look of the ground has been handed over to the plane's (`airHandover`). */
  readonly handover: number;
}

/** Writes the uniform into `target` (its staging, 48 floats) from float 0. Nothing is allocated. */
export function writeGlobeFrameUniform(target: Float32Array, input: GlobeFrameUniformInput): void {
  const L = GlobeFrameUniformLayout;
  const { globe, constants, light } = input;
  target.set(constants.sphereClip, L.sphereClip / 4);
  target.set(constants.sphereWorld, L.sphereWorld / 4);
  target[L.pan / 4] = globe.panX;
  target[L.pan / 4 + 1] = globe.panY;
  target[L.radius / 4] = globe.radius;
  target[L.transition / 4] = globe.transition;
  target[L.mapSize / 4] = constants.mapSize;
  target[L.panMercatorY / 4] = constants.panMercatorY;
  target[L.handover / 4] = input.handover;
  target[L.handover / 4 + 1] = 0;
  target.set(light.lightAndStrength, L.lightAndStrength / 4);
  target.set(light.nightColorAndSoftness, L.nightColorAndSoftness / 4);
}
