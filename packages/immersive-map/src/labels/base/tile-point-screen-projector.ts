// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The base labels' anchors on screen for one camera (the Swift
 * `TilePointScreenProjector`), written in place into the working set's
 * columns: device pixels with the origin at the bottom left, whether the
 * anchor is drawable, whether it is in view (in front of the horizon and
 * within the labels' reach), its shrink for its distance and where it draws
 * in the render world.
 *
 * On the flat map a label naming a building is lifted onto its roof, as far
 * as the buildings drawn over it have risen (`BuildingRiseCoverage`). On the
 * globe and through the unroll the anchor follows the surface the tiles draw
 * (`GlobeUnrollMath`, the CPU mirror of globe.wgsl), cut and hidden by the
 * horizon of the unrolling sphere like the ground under it.
 */

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import { cutClearanceOf, horizonAlphaOf, worldPositionInto } from "../../globe/globe-unroll-math.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { Vec3 } from "../../math/vec.ts";
import type { BuildingRiseCoverage } from "../../tile/placement/building-rise-coverage.ts";
import { type BaseLabelCache, LabelFrameRecordLayout } from "./base-label-cache.ts";

/** The per-label outputs of a projection, index-aligned with the working set. */
export interface LabelProjectionOutputs {
  /** 1 where the anchor is in front of the horizon and within reach. */
  readonly horizonVisible: Uint8Array;
  readonly perspectiveScales: Float32Array;
  /** Where the label draws in the render world, three per label, zero for none. */
  readonly anchors: Float32Array;
}

/** What a projection reads of the frame. */
export interface LabelProjectionFrame {
  /** The camera's projection-view (column-major), the CPU's. */
  readonly projectionView: Mat4;
  readonly eye: Vec3;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** The smallest shrink for distance, 1 for none (`perspectiveMinimumScale`). */
  readonly minimumPerspectiveScale: number;
  /** The reach in multiples of the camera's depth of its focus (`LabelDistanceRules`). */
  readonly maximumDistanceScale: number;
}

/** The flat map's frame: each tile slot's origin and size in render units, three per slot. */
export interface FlatLabelProjectionFrame extends LabelProjectionFrame {
  readonly slotOrigins: Float64Array;
  readonly buildingRise: BuildingRiseCoverage;
  /**
   * The ground relief's lift under a point of a tile, in world units
   * (`GroundReliefTileLift`), `undefined` on the plane: the relief under the
   * label lifts it, roof or ground.
   */
  readonly groundLift?: ((tileZ: number, tileX: number, tileY: number, u: number, v: number) => number) | undefined;
}

/** The globe's frame. */
export interface GlobeLabelProjectionFrame extends LabelProjectionFrame {
  readonly globe: GlobeUniform;
  /** `GlobeFrameConstants.sphereWorld`: the unit earth direction to the world's sphere position. */
  readonly sphereWorld: Mat4;
  readonly mapSize: number;
  readonly panMercatorY: number;
}

/** A label's shrink for its distance, from the clip-space w of its anchor. */
function perspectiveScale(focusDepth: number, minimum: number, clipW: number): number {
  if (!(minimum < 1) || !(focusDepth > 0) || !(clipW > 0)) return 1;
  return Math.min(Math.max(focusDepth / clipW, minimum), 1);
}

const roofTile = { x: 0, y: 0, z: 0 };

/** Projects the labels of `spans` on the flat map. */
export function projectFlatLabels(cache: BaseLabelCache, frame: FlatLabelProjectionFrame, spans: ArrayLike<number>, out: LabelProjectionOutputs): void {
  const L = LabelFrameRecordLayout;
  const m = frame.projectionView;
  // The view depth of the point the camera looks at: the world origin.
  const focusDepth = m[15]!;
  const maximumDepth = focusDepth * Math.max(frame.maximumDistanceScale, 0);
  const minimum = frame.minimumPerspectiveScale;
  const halfWidth = frame.viewportWidth * 0.5;
  const halfHeight = frame.viewportHeight * 0.5;
  const records = cache.frameRecords;
  const uv = cache.uv;
  const slots = cache.tileSlots;
  const tiles = cache.tiles;
  const origins = frame.slotOrigins;
  const slotCount = origins.length / 3;
  const rise = frame.buildingRise;
  const groundLift = frame.groundLift;
  const count = cache.labelCount;
  for (let s = 0; s + 1 < spans.length; s += 2) {
    const end = Math.min(spans[s + 1]!, count);
    for (let index = spans[s]!; index < end; index++) {
      const r = index * L.floats;
      const slot = slots[index]!;
      if (slot >= slotCount) {
        records[r + L.visible] = 0;
        out.horizonVisible[index] = 0;
        out.anchors[index * 3] = out.anchors[index * 3 + 1] = out.anchors[index * 3 + 2] = 0;
        continue;
      }
      const size = origins[slot * 3 + 2]!;
      const u = uv[index * 2]!;
      const v = uv[index * 2 + 1]!;
      // v grows from the north edge, the flat render world is y up.
      const x = origins[slot * 3]! + u * size;
      const y = origins[slot * 3 + 1]! + (1 - v) * size;
      // The relief under the label lifts it, roof or ground.
      let z = groundLift === undefined ? 0 : groundLift(tiles[index * 3]!, tiles[index * 3 + 1]!, tiles[index * 3 + 2]!, u, v);
      // The roof is in the tile's 4096 units, the extrusion mesh's scale.
      const roof = cache.roofHeight[index]!;
      if (cache.liftsToRoof[index] !== 0 && roof > 0 && !rise.isEmpty) {
        roofTile.z = tiles[index * 3]!;
        roofTile.x = tiles[index * 3 + 1]!;
        roofTile.y = tiles[index * 3 + 2]!;
        z += ((roof * size) / 4096) * rise.rise(roofTile, u, v);
      }
      const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (cw > 0) {
        const inverseW = 1 / cw;
        records[r + L.screenX] = (cx * inverseW + 1) * halfWidth;
        records[r + L.screenY] = (cy * inverseW + 1) * halfHeight;
        records[r + L.visible] = 1;
        // The flat map has no horizon: a point is in view where it projects within reach.
        out.horizonVisible[index] = cw <= maximumDepth ? 1 : 0;
      } else {
        records[r + L.screenX] = 0;
        records[r + L.screenY] = 0;
        records[r + L.visible] = 0;
        out.horizonVisible[index] = 0;
      }
      out.perspectiveScales[index] = perspectiveScale(focusDepth, minimum, cw);
      out.anchors[index * 3] = x;
      out.anchors[index * 3 + 1] = y;
      out.anchors[index * 3 + 2] = z;
    }
  }
}

const worldScratch = [0, 0, 0];

/**
 * Projects the labels of `spans` on the globe and through the unroll: the
 * anchor's unit earth direction to the sphere, on the resting sphere as it
 * is, through the unroll toward its Mercator place otherwise. In view where
 * the unrolling sphere's horizon does not hide it, the unroll's cut does not
 * drop it, and it is within reach.
 */
export function projectGlobeLabels(cache: BaseLabelCache, frame: GlobeLabelProjectionFrame, spans: ArrayLike<number>, out: LabelProjectionOutputs): void {
  const L = LabelFrameRecordLayout;
  const m = frame.projectionView;
  const w = frame.sphereWorld;
  const { transition, radius, panX } = frame.globe;
  const focusDepth = m[15]!;
  const maximumDepth = focusDepth * Math.max(frame.maximumDistanceScale, 0);
  const minimum = frame.minimumPerspectiveScale;
  const halfWidth = frame.viewportWidth * 0.5;
  const halfHeight = frame.viewportHeight * 0.5;
  const mapSize = frame.mapSize;
  const halfMapSize = mapSize * 0.5;
  const records = cache.frameRecords;
  const uv = cache.uv;
  const tiles = cache.tiles;
  const count = cache.labelCount;
  for (let s = 0; s + 1 < spans.length; s += 2) {
    const end = Math.min(spans[s + 1]!, count);
    for (let index = spans[s]!; index < end; index++) {
      const r = index * L.floats;
      const zPow = 2 ** tiles[index * 3]!;
      const worldU = (tiles[index * 3 + 1]! + uv[index * 2]!) / zPow;
      const worldV = (tiles[index * 3 + 2]! + uv[index * 2 + 1]!) / zPow;
      // The unit earth direction (globeWorldUVUnitDirection).
      const latitudeArgument = Math.PI * (1 - 2 * worldV);
      const sinLatitude = Math.tanh(latitudeArgument);
      const cosLatitude = 1 / Math.cosh(latitudeArgument);
      const longitude = worldU * 2 * Math.PI - Math.PI;
      const ux = cosLatitude * Math.sin(longitude);
      const uy = sinLatitude;
      const uz = cosLatitude * Math.cos(longitude);
      const sx = w[0]! * ux + w[4]! * uy + w[8]! * uz + w[12]!;
      const sy = w[1]! * ux + w[5]! * uy + w[9]! * uz + w[13]!;
      const sz = w[2]! * ux + w[6]! * uy + w[10]! * uz + w[14]!;
      let wx = sx;
      let wy = sy;
      let wz = sz;
      let clearance = 1;
      if (transition > 0) {
        const mercatorY = Math.min(Math.max(1 - 2 * worldV, -1), 1);
        const fx = ImmersiveMapProjection.wrap(worldU * mapSize - halfMapSize + panX * halfMapSize, mapSize);
        const fy = (mercatorY - frame.panMercatorY) * halfMapSize;
        worldPositionInto(worldScratch, sx, sy, sz, fx, fy, transition, radius);
        wx = worldScratch[0]!;
        wy = worldScratch[1]!;
        wz = worldScratch[2]!;
        clearance = cutClearanceOf(sx, sy, sz, fx, fy, transition, radius);
      }
      const cx = m[0]! * wx + m[4]! * wy + m[8]! * wz + m[12]!;
      const cy = m[1]! * wx + m[5]! * wy + m[9]! * wz + m[13]!;
      const cw = m[3]! * wx + m[7]! * wy + m[11]! * wz + m[15]!;
      if (cw > 0 && clearance >= 0) {
        const inverseW = 1 / cw;
        records[r + L.screenX] = (cx * inverseW + 1) * halfWidth;
        records[r + L.screenY] = (cy * inverseW + 1) * halfHeight;
        records[r + L.visible] = 1;
        const horizon = horizonAlphaOf(wx, wy, wz, frame.eye, transition, radius) >= 0.5;
        out.horizonVisible[index] = horizon && cw <= maximumDepth ? 1 : 0;
      } else {
        records[r + L.screenX] = 0;
        records[r + L.screenY] = 0;
        records[r + L.visible] = 0;
        out.horizonVisible[index] = 0;
      }
      out.perspectiveScales[index] = perspectiveScale(focusDepth, minimum, cw);
      out.anchors[index * 3] = wx;
      out.anchors[index * 3 + 1] = wy;
      out.anchors[index * 3 + 2] = wz;
    }
  }
}
