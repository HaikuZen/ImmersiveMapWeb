// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapTerrainOcclusion } from "../../../style/theme.ts";

/**
 * What a terrain tile's occlusion of the sky is computed with, a port of
 * the Swift `GroundReliefOcclusion.Key`: the same key, the same bytes. A
 * style that darkens nothing has a resolution of 0, and nothing is computed
 * for it. The computation itself (the mean over `directions` of the sine of
 * the horizon's elevation out to the radius, for a grid of `resolution`
 * points a side) runs where decision B10 put it (docs/benchmarks/B10-occlusion.md).
 */
export interface GroundReliefOcclusionKey {
  readonly radiusMetres: number;
  readonly directions: number;
  readonly resolution: number;
}

export const GroundReliefOcclusionKey = {
  /** A key with the Swift clamps: the radius at least 0, 4 to 32 directions, a resolution of 0 or 16 to 1024. */
  make(radiusMetres: number, directions: number, resolution: number): GroundReliefOcclusionKey {
    const integer = (value: number) => (Number.isFinite(value) ? Math.trunc(value) : 0);
    const steps = integer(resolution);
    return Object.freeze({
      radiusMetres: Math.max(0, Number.isFinite(radiusMetres) ? radiusMetres : 0),
      directions: Math.min(Math.max(integer(directions), 4), 32),
      resolution: steps <= 0 ? 0 : Math.min(Math.max(steps, 16), 1024),
    });
  },

  /** A style's key: its resolution, 0 when the style darkens nothing. */
  ofStyle(style: ImmersiveMapTerrainOcclusion): GroundReliefOcclusionKey {
    return GroundReliefOcclusionKey.make(style.radiusMeters, style.directions, style.isEnabled ? style.resolution : 0);
  },

  /** Whether anything is computed under this key. */
  computes(key: GroundReliefOcclusionKey): boolean {
    return key.resolution > 0 && key.radiusMetres > 0;
  },

  equals(lhs: GroundReliefOcclusionKey | undefined, rhs: GroundReliefOcclusionKey | undefined): boolean {
    if (lhs === undefined || rhs === undefined) return lhs === rhs;
    return lhs.radiusMetres === rhs.radiusMetres && lhs.directions === rhs.directions && lhs.resolution === rhs.resolution;
  },
} as const;
