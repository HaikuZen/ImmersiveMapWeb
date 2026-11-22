// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { mat4Invert } from "../../../math/mat4-invert.ts";
import type { Mat4 } from "../../../math/matrix.ts";
import type { Vec2 } from "../../../math/vec.ts";
import type { GroundReliefFrame } from "../frame/ground-relief-frame.ts";

const inverseScratch: Mat4 = new Float64Array(16);

/**
 * Draws the terrain from under the point the camera looks at, a port of the
 * Swift `GroundReliefCameraLift`. The flattened ground rises by its heights
 * less the terrain under that point, the datum: the point lies at the
 * world's origin, on the ground, so the frame's pose, made for a point on
 * the plane, holds as it is, the camera turns about a point on the ground
 * and a zoom closes in on it. One terrain lookup a frame, a datum every
 * receiver subtracts: nothing per vertex.
 */
export const GroundReliefCameraLift = {
  /**
   * The terrain under the point the camera looks at, in metres before the
   * exaggeration: the frame's datum. Read off the camera's map, the one map
   * the camera flies over at every zoom, or, while that map is on its way,
   * off the terrain the frame's near ring draws there. Zero over tiles
   * coarser than the relief's zoom, which lie on the plane. `undefined`
   * while no terrain under the point is in.
   */
  datumMetres(relief: GroundReliefFrame, centerWorldMercator: Vec2, tileZoom: number): number | undefined {
    if (tileZoom < relief.fromTileZoom) return 0;
    return relief.elevation(centerWorldMercator, relief.cameraTerrainZoom) ?? relief.elevation(centerWorldMercator, relief.terrainZoom(tileZoom));
  },

  /**
   * The view depth of the point where the centre of the screen meets the
   * terrain, drawn from the frame's datum: what the point-locked road
   * widths are stated at. `undefined` where the terrain under the centre is
   * on its way or the centre ray misses the ground. `cameraMatrix` is the
   * frame's projection-view (column-major). The ray is walked onto the
   * bilinear terrain in three steps: from where it meets the plane, to the
   * plane of the terrain's height there, and again.
   */
  centreGroundDepth(relief: GroundReliefFrame, cameraMatrix: Mat4, centerWorldMercator: Vec2, tileZoom: number, renderMapSize: number): number | undefined {
    if (tileZoom < relief.fromTileZoom) return undefined;
    const m = inverseScratch;
    if (!mat4Invert(m, cameraMatrix)) return undefined;
    const unproject = (z: number): [number, number, number] | undefined => {
      const x = m[8]! * z + m[12]!;
      const y = m[9]! * z + m[13]!;
      const zz = m[10]! * z + m[14]!;
      const w = m[11]! * z + m[15]!;
      if (Math.abs(w) <= Number.MIN_VALUE) return undefined;
      return [x / w, y / w, zz / w];
    };
    const near = unproject(0);
    const far = unproject(1);
    if (near === undefined || far === undefined) return undefined;
    const descent = near[2] - far[2];
    if (Math.abs(descent) <= Number.MIN_VALUE) return undefined;
    const zoom = relief.terrainZoom(tileZoom);
    let height = 0;
    let gx = near[0];
    let gy = near[1];
    for (let step = 0; step < 3; step++) {
      const t = (near[2] - height) / descent;
      if (!Number.isFinite(t) || !(t > 0)) return undefined;
      gx = near[0] + (far[0] - near[0]) * t;
      gy = near[1] + (far[1] - near[1]) * t;
      const point: Vec2 = [centerWorldMercator[0] + gx / renderMapSize, centerWorldMercator[1] - gy / renderMapSize];
      const drawn = relief.drawnMetres(point, zoom);
      if (drawn === undefined) return undefined;
      // The ground's rise, the frame's.
      height = (drawn - relief.datumMetres) * relief.worldUnitsPerMetre;
    }
    const depth = cameraMatrix[3]! * gx + cameraMatrix[7]! * gy + cameraMatrix[11]! * height + cameraMatrix[15]!;
    return Number.isFinite(depth) && depth > 0 ? depth : undefined;
  },
} as const;
