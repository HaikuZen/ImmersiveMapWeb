// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec3 } from "../math/vec.ts";
import { tileIndex } from "../tile/tile-index.ts";
import type { Tile } from "../tile/tile.ts";
import type { GlobeUniform } from "./globe-uniform.ts";

/**
 * What the globe's tile visibility tests read, taken off the frame once: the
 * globe, the eye, the sphere's centre in the camera's world (the camera looks
 * at the world origin, the sphere's front point), the pan as a rotation, and
 * the horizon test's terms.
 */
export interface GlobeVisibilityInputs {
  readonly globe: GlobeUniform;
  readonly cameraEye: Vec3;
  readonly globeCenter: Vec3;
  readonly transition: number;
  /**
   * The pan's rotation as the three columns a direction is dotted with (the
   * Swift engine's `SIMD4(direction, 0) * rotation`), column by column.
   */
  readonly rotation: readonly [number, number, number, number, number, number, number, number, number];
  readonly globeToCamera: Vec3;
  readonly globeToCameraLength: number;
  readonly horizonThreshold: number;
}

/** A tile's bounding sphere in the camera's world. */
export interface GlobeTileVisibilityBound {
  readonly center: Vec3;
  readonly radius: number;
}

/** A tile's bounding sphere on the unit sphere before the pan: its centre's direction and its radius over the globe's. */
export interface GlobeTileStaticVisibilityBound {
  readonly centerDirection: Vec3;
  readonly radiusScale: number;
}

/** Every tile's static bound, made once: the bounds depend on the tile alone. */
const staticBoundsCache = new Map<number, GlobeTileStaticVisibilityBound>();

function unitSphereDirection(latitude: number, longitude: number): Vec3 {
  const phi = latitude - Math.PI * 0.5;
  const theta = longitude + Math.PI;
  const x = Math.sin(phi) * Math.sin(theta);
  const y = Math.cos(phi);
  const z = Math.sin(phi) * Math.cos(theta);
  const inverseLength = 1 / Math.sqrt(x * x + y * y + z * z);
  return [x * inverseLength, y * inverseLength, z * inverseLength];
}

function angularDistance(lhs: Vec3, rhs: Vec3): number {
  const dot = lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2];
  return Math.acos(Math.min(Math.max(dot, -1.0), 1.0));
}

function unwrapLongitudeMidpoint(west: number, east: number): number {
  const eastUnwrapped = east >= west ? east : east + 2.0 * Math.PI;
  const midpoint = 0.5 * (west + eastUnwrapped);
  return midpoint > Math.PI ? midpoint - 2.0 * Math.PI : midpoint;
}

function makeStaticBoundGeometry(tile: Tile): GlobeTileStaticVisibilityBound {
  const scale = 2 ** tile.z;
  const northLatitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(tile.y / scale);
  const southLatitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY((tile.y + 1) / scale);
  const westLongitude = ImmersiveMapProjection.longitudeFromNormalizedWorldX(tile.x / scale);
  const eastLongitude = ImmersiveMapProjection.longitudeFromNormalizedWorldX((tile.x + 1) / scale);
  const centerLatitude = 0.5 * (northLatitude + southLatitude);
  const centerLongitude = unwrapLongitudeMidpoint(westLongitude, eastLongitude);
  const centerDirection = unitSphereDirection(centerLatitude, centerLongitude);
  if (tile.z === 0) return { centerDirection, radiusScale: 2.0 };
  const corners = [
    unitSphereDirection(northLatitude, westLongitude),
    unitSphereDirection(northLatitude, eastLongitude),
    unitSphereDirection(southLatitude, westLongitude),
    unitSphereDirection(southLatitude, eastLongitude),
  ];
  let maxAngle = 0;
  for (const corner of corners) maxAngle = Math.max(maxAngle, angularDistance(centerDirection, corner));
  return { centerDirection, radiusScale: 2.0 * Math.sin(maxAngle * 0.5) };
}

/**
 * The CPU-side globe tile visibility the coverage walk shares
 * (`GlobeTileCoverage`): each tile's bounding sphere on the panned globe and
 * the horizon tests against it. Globe math only: no GPU, no tile loading, no
 * flat-map visibility.
 */
export const GlobeVisibilityModel = {
  makeInputs(globe: GlobeUniform, cameraEye: Vec3): GlobeVisibilityInputs {
    const panLatitude = globe.panY * ImmersiveMapProjection.maxMercatorLatitude;
    const panLongitude = globe.panX * Math.PI;
    const cx = Math.cos(-panLatitude);
    const sx = Math.sin(-panLatitude);
    const cy = Math.cos(-panLongitude);
    const sy = Math.sin(-panLongitude);
    const globeCenter: Vec3 = [0, 0, -globe.radius];
    const globeToCamera: Vec3 = [cameraEye[0] - globeCenter[0], cameraEye[1] - globeCenter[1], cameraEye[2] - globeCenter[2]];
    return {
      globe,
      cameraEye,
      globeCenter,
      transition: globe.transition,
      rotation: [cy, 0, -sy, sy * sx, cx, cy * sx, sy * cx, -sx, cy * cx],
      globeToCamera,
      globeToCameraLength: Math.hypot(globeToCamera[0], globeToCamera[1], globeToCamera[2]),
      horizonThreshold: globe.radius * globe.radius,
    };
  },

  staticBoundGeometry(tile: Tile): GlobeTileStaticVisibilityBound {
    const key = tileIndex(tile.x, tile.y, tile.z);
    let bound = staticBoundsCache.get(key);
    if (bound === undefined) {
      bound = makeStaticBoundGeometry(tile);
      staticBoundsCache.set(key, bound);
    }
    return bound;
  },

  tileBound(tile: Tile, inputs: GlobeVisibilityInputs): GlobeTileVisibilityBound {
    return GlobeVisibilityModel.tileBoundOf(GlobeVisibilityModel.staticBoundGeometry(tile), inputs);
  },

  tileBoundOf(staticBound: GlobeTileStaticVisibilityBound, inputs: GlobeVisibilityInputs): GlobeTileVisibilityBound {
    const [dx, dy, dz] = staticBound.centerDirection;
    const r = inputs.rotation;
    const radius = inputs.globe.radius;
    const rotatedX = dx * r[0] + dy * r[1] + dz * r[2];
    const rotatedY = dx * r[3] + dy * r[4] + dz * r[5];
    const rotatedZ = dx * r[6] + dy * r[7] + dz * r[8];
    const center = inputs.globeCenter;
    return {
      center: [center[0] + rotatedX * radius, center[1] + rotatedY * radius, center[2] + rotatedZ * radius],
      radius: radius * staticBound.radiusScale,
    };
  },

  tileMayPassHorizon(bound: GlobeTileVisibilityBound, inputs: GlobeVisibilityInputs): boolean {
    if (inputs.globeToCameraLength <= 0 || !GlobeVisibilityModel.horizonRejectEnabled(inputs.transition)) return true;
    const centerDot = horizonDot(bound, inputs);
    return centerDot + bound.radius * inputs.globeToCameraLength >= inputs.horizonThreshold;
  },

  tilePassesHorizonEntirely(bound: GlobeTileVisibilityBound, inputs: GlobeVisibilityInputs): boolean {
    if (inputs.globeToCameraLength <= 0 || !GlobeVisibilityModel.horizonRejectEnabled(inputs.transition)) return true;
    const centerDot = horizonDot(bound, inputs);
    return centerDot - bound.radius * inputs.globeToCameraLength >= inputs.horizonThreshold;
  },

  horizonRejectEnabled(transition: number): boolean {
    return transition <= 0;
  },
} as const;

function horizonDot(bound: GlobeTileVisibilityBound, inputs: GlobeVisibilityInputs): number {
  const c = inputs.globeCenter;
  const g = inputs.globeToCamera;
  return (bound.center[0] - c[0]) * g[0] + (bound.center[1] - c[1]) * g[1] + (bound.center[2] - c[2]) * g[2];
}
