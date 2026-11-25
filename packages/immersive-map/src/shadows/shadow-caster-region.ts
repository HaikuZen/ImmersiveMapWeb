// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The part of a shadow window's slice that changed casters cover: when
 * casters leave a window (a tile leaving the coverage, children giving way
 * to their parent), only the texels their boxes project to in the light's
 * view can hold their depth, so the pass clears that rectangle and draws
 * again the casters over it (`ShadowCasterPassPlan.region`). Not in Swift,
 * which draws the whole map again.
 */

import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { Vec2 } from "../math/vec.ts";
import { type ShadowCasterRegion, ShadowMapReuseController } from "./shadow-map-reuse-controller.ts";

export const ShadowCasterRegionResolver = {
  /**
   * The largest share of the slice a region may cover: past it, drawing
   * the casters over the region costs about what the whole slice does, and
   * the pass clears and draws everything.
   */
  maximumSliceShare: 0.5,

  /**
   * The region the casters of `keys` cover in a window's slice of
   * `resolution` texels a side: each caster's tile from the lowest ground
   * (`heights[0]`) to the highest roof (`heights[1]`), projected by the
   * window's light camera, the rectangle around them all, a texel wider on
   * every side and clamped to the slice. `undefined` when it covers more
   * than `maximumSliceShare` of the slice.
   */
  resolve(
    keys: Iterable<string>,
    lightProjectionView: Mat4,
    flatRenderPan: Vec2,
    renderMapSize: number,
    heights: readonly [number, number],
    resolution: number,
  ): ShadowCasterRegion | undefined {
    const m = lightProjectionView;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const key of keys) {
      const { tile, worldWrap } = ShadowMapReuseController.casterPlace(key);
      const [ox, oy, size] = ImmersiveMapProjection.flatTileOriginAndSize(tile.x, tile.y, tile.z, worldWrap, flatRenderPan, renderMapSize);
      for (let corner = 0; corner < 8; corner++) {
        const x = ox + (corner & 1) * size;
        const y = oy + ((corner >> 1) & 1) * size;
        const z = heights[corner >> 2]!;
        // The light camera is orthographic: w stays 1.
        const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
      }
    }
    // Clip space to texels: u = 0.5x + 0.5, v = 0.5 - 0.5y (the texture's origin is top-left).
    const clampTexel = (v: number) => Math.min(Math.max(v, 0), resolution);
    let x0 = 0;
    let x1 = 0;
    let y0 = 0;
    let y1 = 0;
    if (minX <= maxX && minY <= maxY) {
      x0 = clampTexel(Math.floor((minX * 0.5 + 0.5) * resolution) - 1);
      x1 = clampTexel(Math.ceil((maxX * 0.5 + 0.5) * resolution) + 1);
      y0 = clampTexel(Math.floor((0.5 - maxY * 0.5) * resolution) - 1);
      y1 = clampTexel(Math.ceil((0.5 - minY * 0.5) * resolution) + 1);
    }
    const width = Math.max(x1 - x0, 0);
    const height = Math.max(y1 - y0, 0);
    if (width * height > ShadowCasterRegionResolver.maximumSliceShare * resolution * resolution) return undefined;
    return { scissor: [x0, y0, width, height], cullingProjectionView: croppedProjection(m, x0, y0, width, height, resolution) };
  },
} as const;

/**
 * The light camera with its clip square narrowed to the texel rectangle:
 * what lies outside the rectangle lies outside this camera's view, so the
 * casters are culled by it as by the window's own camera. An empty
 * rectangle crops to a sliver nothing passes.
 */
function croppedProjection(m: Mat4, x0: number, y0: number, width: number, height: number, resolution: number): Float64Array {
  const left = (x0 / resolution) * 2 - 1;
  const right = ((x0 + Math.max(width, 1e-6)) / resolution) * 2 - 1;
  const top = 1 - (y0 / resolution) * 2;
  const bottom = 1 - ((y0 + Math.max(height, 1e-6)) / resolution) * 2;
  const sx = 2 / (right - left);
  const sy = 2 / (top - bottom);
  const tx = -(right + left) / (right - left);
  const ty = -(top + bottom) / (top - bottom);
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    const c = column * 4;
    out[c] = sx * m[c]! + tx * m[c + 3]!;
    out[c + 1] = sy * m[c + 1]! + ty * m[c + 3]!;
    out[c + 2] = m[c + 2]!;
    out[c + 3] = m[c + 3]!;
  }
  return out;
}
