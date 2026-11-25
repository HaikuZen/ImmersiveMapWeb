// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Which quarters of a placed tile the camera can see (`TileQuarters`): a
 * quarter whose box, from the ground up to a ceiling no building reaches,
 * lies wholly past one side of the clip volume draws nothing on screen.
 * The buildings and the trees draw only the quarters a frame can see, so a
 * coarse tile of the far ring or a tile at the frame's edge sends its
 * visible part alone to the GPU. Not a Swift port: the Swift engine draws
 * every quarter the placement names. The shadow
 * casters are culled the same way against each window's light projection:
 * a building off screen still casts into the frame, but not one outside the
 * window's square in the light's view, along which the light projects.
 * The far window's casters also leave out the quarters inside its caster
 * hole (`quartersOutsideDisc`), whose shadows no receiver reads from it.
 */

import { quarterCount, quartersAll } from "../tile-quarters.ts";
import type { Mat4 } from "../../math/matrix.ts";

/**
 * The quarters of `mask` in view. The tile is the square from (`originX`,
 * `originY`) of side `size` in the flat world, y up (north at the top),
 * standing up to `ceiling` world units. `byQuarters` false tests the tile
 * whole: it draws all of its quarters or none.
 */
export function visibleQuarters(projectionView: Mat4, originX: number, originY: number, size: number, ceiling: number, mask: number, byQuarters: boolean): number {
  if (!byQuarters) return boxInView(projectionView, originX, originY, size, ceiling) ? mask : 0;
  const half = size / 2;
  let visible = 0;
  for (let q = 0; q < quarterCount; q++) {
    if ((mask & (1 << q)) === 0) continue;
    // Quarter 0 is the north-west, 1 the north-east, 2 the south-west, 3 the south-east.
    const x = originX + (q & 1) * half;
    const y = originY + ((q >> 1) === 0 ? half : 0);
    if (boxInView(projectionView, x, y, half, ceiling)) visible |= 1 << q;
  }
  return visible & quartersAll;
}

/**
 * The quarters of `mask` not wholly inside the disc of `radius` about
 * (`centerX`, `centerY`) in the flat world: a quarter is left out only when
 * its farthest corner lies inside. `byQuarters` false tests the tile whole.
 */
export function quartersOutsideDisc(originX: number, originY: number, size: number, mask: number, byQuarters: boolean, centerX: number, centerY: number, radius: number): number {
  const inside = (x: number, y: number, side: number): boolean => {
    const dx = Math.max(Math.abs(x - centerX), Math.abs(x + side - centerX));
    const dy = Math.max(Math.abs(y - centerY), Math.abs(y + side - centerY));
    return dx * dx + dy * dy <= radius * radius;
  };
  if (!byQuarters) return inside(originX, originY, size) ? 0 : mask;
  const half = size / 2;
  let outside = 0;
  for (let q = 0; q < quarterCount; q++) {
    if ((mask & (1 << q)) === 0) continue;
    const x = originX + (q & 1) * half;
    const y = originY + ((q >> 1) === 0 ? half : 0);
    if (!inside(x, y, half)) outside |= 1 << q;
  }
  return outside & quartersAll;
}

/** Whether the box may show: false only when its eight corners lie past one plane of the clip volume. */
function boxInView(m: Mat4, x0: number, y0: number, side: number, ceiling: number): boolean {
  let left = 0;
  let right = 0;
  let below = 0;
  let above = 0;
  let behind = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = x0 + (corner & 1) * side;
    const y = y0 + ((corner >> 1) & 1) * side;
    const z = (corner >> 2) * ceiling;
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (cx < -cw) left++;
    if (cx > cw) right++;
    if (cy < -cw) below++;
    if (cy > cw) above++;
    if (cw <= 0) behind++;
  }
  return left < 8 && right < 8 && below < 8 && above < 8 && behind < 8;
}
