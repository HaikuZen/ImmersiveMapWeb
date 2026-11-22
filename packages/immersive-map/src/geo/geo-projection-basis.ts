// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Vec3 } from "../math/vec.ts";
import type { GeoCoordinate } from "./geo-coordinate.ts";
import { ImmersiveMapProjection } from "./immersive-map-projection.ts";

/**
 * Cacheable trigonometry of a geocoordinate projection: sin, cos and log are
 * computed once when the coordinate changes, so the per-frame point
 * projection stays linear algebra (no per-point trigonometry per frame).
 */
export interface GeoProjectionBasis {
  /**
   * Unit vector of the point on the sphere in the globe formula's frame
   * (before the pan rotation): (cosLat*sinLon, sinLat, cosLat*cosLon).
   */
  readonly sphereUnit: Vec3;
  /** (lon + pi) / 2pi, normalized X of the world unwrap. */
  readonly normalizedWorldX: number;
  /** Normalized Mercator Y of the latitude. */
  readonly mercatorYNormalized: number;
}

export const GeoProjectionBasis = {
  fromCoordinate(coordinate: GeoCoordinate): GeoProjectionBasis {
    return GeoProjectionBasis.fromRadians((coordinate.latitude * Math.PI) / 180.0, (coordinate.longitude * Math.PI) / 180.0);
  },

  fromRadians(latitudeRadians: number, longitudeRadians: number): GeoProjectionBasis {
    const cosLatitude = Math.cos(latitudeRadians);
    return {
      sphereUnit: [cosLatitude * Math.sin(longitudeRadians), Math.sin(latitudeRadians), cosLatitude * Math.cos(longitudeRadians)],
      normalizedWorldX: (longitudeRadians + Math.PI) / (2.0 * Math.PI),
      mercatorYNormalized: ImmersiveMapProjection.yMercatorNormalized(latitudeRadians),
    };
  },
} as const;
