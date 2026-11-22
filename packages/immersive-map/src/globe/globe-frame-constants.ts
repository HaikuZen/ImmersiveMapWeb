// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../camera/view-mode.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { type Mat4, mat4Multiply, mat4Transpose } from "../math/matrix.ts";
import type { Tile } from "../tile/tile.ts";
import type { GlobeUniform } from "./globe-uniform.ts";
import { GlobeSunDirection } from "./globe-sun-direction.ts";

/**
 * Per-frame derivatives of the globe uniform, computed once on the CPU
 * instead of once per vertex: a port of the Swift
 * `GlobeFrameConstantsUniform`. The hot globe vertex stages take the
 * composed sphere matrices (`sphereClip` carries a unit earth direction
 * straight to clip space, `sphereWorld` to the world-space sphere
 * position), the flat morph target's map size and Mercator pan, and the
 * unroll curvature. `rotation` keeps the row-vector column layout the
 * shaders' visibility math multiplies with (`v * M`), the composed matrices
 * are column-vector (`M * v`) like the camera matrix. All column-major.
 */
export interface GlobeFrameConstants {
  readonly rotation: Mat4;
  readonly sphereClip: Mat4;
  readonly sphereWorld: Mat4;
  readonly mapSize: number;
  readonly panMercatorY: number;
  readonly panLatitude: number;
  readonly panLongitude: number;
  readonly curvature: number;
}

export const GlobeFrameConstants = {
  /** The constants of a frame's globe under the camera matrix the GPU draws with. */
  make(globe: GlobeUniform, cameraMatrix: Mat4): GlobeFrameConstants {
    const panLatitude = globe.panY * ImmersiveMapProjection.maxMercatorLatitude;
    const panLongitude = globe.panX * Math.PI;
    // Mirror of globeTransitionMapSize: the flat morph target grows from
    // cos(center latitude) up to the full Mercator size.
    const mapSizeScale = (1.0 - globe.transition) * Math.cos(panLatitude) + globe.transition;
    const mapSize = 2.0 * Math.PI * globe.radius * mapSizeScale;
    const panMercatorY = ImmersiveMapProjection.yMercatorNormalized(panLatitude);
    const rotation = GlobeSunDirection.rotationMatrix(panLatitude, panLongitude);
    // sphereWorld = translate(0, 0, -R) * transpose(rotation) * scale(R).
    const radius = globe.radius;
    const sphereWorld = mat4Transpose(new Float64Array(16), rotation);
    for (let index = 0; index < 12; index++) sphereWorld[index] = sphereWorld[index]! * radius;
    sphereWorld[14] = sphereWorld[14]! - radius;
    const sphereClip = mat4Multiply(new Float64Array(16), cameraMatrix, sphereWorld);
    const curvature = (1.0 - globe.transition) / Math.max(radius, 1e-6);
    return { rotation, sphereClip, sphereWorld, mapSize, panMercatorY, panLatitude, panLongitude, curvature };
  },
} as const;

/**
 * Whether this frame's globe surface vertices take the pure-sphere path:
 * at transition 0 the surface is the sphere, and the vertex stages fold the
 * flat morph target, the unroll and its cut away (an override constant).
 * One rule for the placement marks, the raster rings and the vector ground,
 * so they never disagree within a frame. The Swift `GlobeSphereVertexPath`.
 */
export const GlobeSphereVertexPath = {
  isPureSphere(renderSurfaceMode: ViewMode, transition: number): boolean {
    return renderSurfaceMode === "spherical" && transition === 0;
  },
} as const;

/**
 * Per-draw tile identity of the sphere pipelines, precomputed so the vertex
 * stage does no per-vertex `pow(2, z)`: the Swift `GlobeSurfaceTileUniform`.
 */
export interface GlobeSurfaceTile {
  /** World uv of the tile's north-west corner (x east, y the Mercator row). */
  readonly uvOrigin: readonly [number, number];
  /** Tile-local uv to world uv: `1 / 2^z`. */
  readonly uvScale: number;
  /** The normalized world x the flat morph target unwraps around: the tile's centre. */
  readonly referenceWorldX: number;
}

export const GlobeSurfaceTile = {
  of(tile: Tile): GlobeSurfaceTile {
    const zPow = 2 ** tile.z;
    return { uvOrigin: [tile.x / zPow, tile.y / zPow], uvScale: 1.0 / zPow, referenceWorldX: (tile.x + 0.5) / zPow };
  },

  /** Writes the four floats into a draw record at float index `index` (the record's first row). */
  write(target: Float32Array, index: number, tile: Tile): void {
    const zPow = 2 ** tile.z;
    target[index] = tile.x / zPow;
    target[index + 1] = tile.y / zPow;
    target[index + 2] = 1.0 / zPow;
    target[index + 3] = (tile.x + 0.5) / zPow;
  },
} as const;

/**
 * The dash proportion of the coarsest sources on the globe: their tiles span
 * a large part of the planet, and a full-length dash would read as a solid
 * line there. The Swift `GlobeLineDashScale`.
 */
export const GlobeLineDashScale = {
  coarseTileDashScale(sourceTileZoom: number): number {
    if (sourceTileZoom <= 1) return 0.7;
    if (sourceTileZoom === 2) return 0.9;
    return 1.0;
  },
} as const;
