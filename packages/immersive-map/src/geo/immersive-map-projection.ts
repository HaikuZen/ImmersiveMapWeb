// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec2, Vec3 } from "../math/vec.ts";

/**
 * The `geo` folder: the projection and great-circle math the engine shares
 * (coordinate conversion, path sampling) with no knowledge of styles, render
 * passes or UI. Small, deterministic, and free of camera controllers, GPU
 * resources, tile loading, and label or pin runtime state.
 *
 * Spaces, as the Swift engine names them:
 * - geographic: latitude and longitude, in radians here (degrees in
 *   `GeoCoordinate`);
 * - normalized world Mercator (`centerWorldMercator`): x east and y south,
 *   both in [0, 1], x wrapped and y clamped. A tile `(x, y, z)` covers
 *   `[x, x + 1] / 2^z` by `[y, y + 1] / 2^z` of it;
 * - normalized Mercator Y (`yMercatorNormalized`): north up, in [-1, 1];
 * - the flat render world: y up, `renderMapSize` units across, relative to
 *   the view (`flatWorldPosition`, `flatTileOriginAndSize`).
 */
export const ImmersiveMapProjection = {
  maxMercatorLatitude: 2.0 * Math.atan(Math.exp(Math.PI)) - Math.PI * 0.5,

  /** Equatorial Earth circumference in meters (WGS84). */
  earthCircumferenceMeters: 40_075_016.686,

  /**
   * Render units per ground meter on the flat WebMercator map at the given
   * latitude: the full `renderMapSize` spans the equatorial circumference,
   * and Mercator stretches ground distances by 1/cos(latitude).
   */
  worldUnitsPerMeter(latitudeRadians: number, renderMapSize: number): number {
    const limit = ImmersiveMapProjection.maxMercatorLatitude;
    const clampedLatitude = Math.min(Math.max(-limit, latitudeRadians), limit);
    return renderMapSize / (ImmersiveMapProjection.earthCircumferenceMeters * Math.cos(clampedLatitude));
  },

  wrapNormalizedWorldX(x: number): number {
    let wrapped = x % 1.0;
    if (wrapped < 0) {
      wrapped += 1.0;
    }
    return wrapped;
  },

  clampNormalizedWorldY(y: number): number {
    return Math.min(Math.max(0.0, y), 1.0);
  },

  /** Normalized world Mercator of a latitude and longitude in radians. */
  worldMercator(latitude: number, longitude: number): Vec2 {
    const limit = ImmersiveMapProjection.maxMercatorLatitude;
    const clampedLatitude = Math.min(Math.max(-limit, latitude), limit);
    const x = ImmersiveMapProjection.wrapNormalizedWorldX((longitude + Math.PI) / (2.0 * Math.PI));
    const yMercator = ImmersiveMapProjection.yMercatorNormalized(clampedLatitude);
    const y = ImmersiveMapProjection.clampNormalizedWorldY((1.0 - yMercator) * 0.5);
    return [x, y];
  },

  /** Latitude in radians of a normalized world Y. */
  latitudeFromNormalizedWorldY(y: number): number {
    const clampedY = ImmersiveMapProjection.clampNormalizedWorldY(y);
    const mercatorY = (1.0 - 2.0 * clampedY) * Math.PI;
    return 2.0 * Math.atan(Math.exp(mercatorY)) - Math.PI * 0.5;
  },

  /** Longitude in radians of a normalized world X. */
  longitudeFromNormalizedWorldX(x: number): number {
    return ImmersiveMapProjection.wrapNormalizedWorldX(x) * (2.0 * Math.PI) - Math.PI;
  },

  flatPan(centerWorldMercator: Vec2): Vec2 {
    const centerX = ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]);
    const centerY = ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]);
    return [1.0 - 2.0 * centerX, 1.0 - 2.0 * centerY];
  },

  globePan(centerWorldMercator: Vec2): Vec2 {
    const centerX = ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]);
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(centerWorldMercator[1]);
    const normalizedLatitude = latitude / ImmersiveMapProjection.maxMercatorLatitude;
    return [1.0 - 2.0 * centerX, Math.min(Math.max(normalizedLatitude, -1.0), 1.0)];
  },

  centerWorldMercatorFromFlatPan(flatPan: Vec2): Vec2 {
    const x = ImmersiveMapProjection.wrapNormalizedWorldX((1.0 - flatPan[0]) * 0.5);
    const y = ImmersiveMapProjection.clampNormalizedWorldY((1.0 - flatPan[1]) * 0.5);
    return [x, y];
  },

  centerWorldMercatorFromGlobePan(globePan: Vec2): Vec2 {
    const longitude = -globePan[0] * Math.PI;
    const latitude = Math.min(Math.max(globePan[1], -1.0), 1.0) * ImmersiveMapProjection.maxMercatorLatitude;
    return ImmersiveMapProjection.worldMercator(latitude, longitude);
  },

  /**
   * Returns tile origin (`x`, `y`) and size (`z`) in flat render-local space.
   * Coordinates are view-relative: the frame-local render pan and the world
   * wrap (`worldWrap`, the copy of the world) are already applied.
   */
  flatTileOriginAndSize(x: number, y: number, z: number, worldWrap: number, flatRenderPan: Vec2, renderMapSize: number): Vec3 {
    const tilesCount = 2 ** z;
    const tileSize = renderMapSize / tilesCount;
    const halfRenderMapSize = renderMapSize * 0.5;
    const originX = x * tileSize - halfRenderMapSize + flatRenderPan[0] * halfRenderMapSize + worldWrap * renderMapSize;
    // Tile row index grows SOUTH while the flat render world is y-up:
    // this is where the two meet.
    const originY = (tilesCount - y - 1) * tileSize - halfRenderMapSize - flatRenderPan[1] * halfRenderMapSize;
    return [originX, originY, tileSize];
  },

  /**
   * Returns flat WebMercator coordinates in frame-local render space. The
   * result is relative to the current flat render view, not an absolute
   * semantic world position.
   */
  flatWorldPosition(latitude: number, longitude: number, flatRenderPan: Vec2, renderMapSize: number): Vec2 {
    const halfRenderMapSize = renderMapSize * 0.5;
    const xNorm = (longitude + Math.PI) / (2.0 * Math.PI);
    const xWorld = ImmersiveMapProjection.wrap(
      xNorm * renderMapSize - halfRenderMapSize + flatRenderPan[0] * halfRenderMapSize,
      renderMapSize,
    );
    const yNorm = ImmersiveMapProjection.yMercatorNormalized(latitude);
    const yWorld = (yNorm - flatRenderPan[1]) * halfRenderMapSize;
    return [xWorld, yWorld];
  },

  /**
   * Converts latitude in radians to normalized WebMercator Y (`[-1, 1]`),
   * with pole clamping to keep the value finite.
   */
  yMercatorNormalized(latitude: number): number {
    const sinLatitude = Math.sin(latitude);
    const maxSinLatitude = Math.tanh(Math.PI);
    const clamped = Math.max(-maxSinLatitude, Math.min(maxSinLatitude, sinLatitude));
    const yMercator = 0.5 * Math.log((1.0 + clamped) / (1.0 - clamped));
    return yMercator / Math.PI;
  },

  /** `value` brought into `[-size / 2, size / 2)`. */
  wrap(value: number, size: number): number {
    return value - size * Math.floor((value + size * 0.5) / size);
  },
} as const;
