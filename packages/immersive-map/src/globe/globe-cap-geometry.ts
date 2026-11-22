// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgba } from "../configuration/color.ts";
import type { ImmersiveMapBaseColors } from "../style/theme.ts";

/** A polar cap's grid: (latitude, longitude) in radians per vertex, and its triangles. */
export interface GlobeCapGrid {
  readonly latLon: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
}

/**
 * The polar caps' geometry, a port of the Swift `CapGeometry`: the sphere
 * past the Mercator edge as a latitude-longitude grid from the cap's
 * boundary (overlapping the last tile row by `boundaryOverlapRadians`, so
 * no seam opens between them) to the pole.
 */
export const GlobeCapGeometry = {
  boundaryOverlapRadians: 0.005,

  /**
   * The grid of a cap, `stacks` rows from its start latitude to its end and
   * `slices` columns around the pole. Both caps read counter-clockwise from
   * outside the sphere with this triangle order, so the caps cull back faces
   * the way the tile mesh does and the far half of the polar fan is never
   * rasterized. 16-bit indices where the vertices allow.
   */
  createCapGrid(stacks: number, slices: number, isNorth: boolean, maxLatitude: number): GlobeCapGrid {
    const overlap = GlobeCapGeometry.boundaryOverlapRadians;
    const northStart = Math.max(maxLatitude - overlap, 0);
    const southEnd = Math.min(-maxLatitude + overlap, 0);
    const latStart = isNorth ? northStart : -Math.PI / 2;
    const latEnd = isNorth ? Math.PI / 2 : southEnd;
    const latLon = new Float32Array((stacks + 1) * (slices + 1) * 2);
    let v = 0;
    for (let stack = 0; stack <= stacks; stack++) {
      const lat = latStart + (latEnd - latStart) * (stack / stacks);
      for (let slice = 0; slice <= slices; slice++) {
        latLon[v++] = lat;
        latLon[v++] = (slice / slices) * Math.PI * 2;
      }
    }
    const vertexCount = (stacks + 1) * (slices + 1);
    const count = stacks * slices * 6;
    const indices = vertexCount <= 0x10000 ? new Uint16Array(count) : new Uint32Array(count);
    let i = 0;
    for (let stack = 0; stack < stacks; stack++) {
      for (let slice = 0; slice < slices; slice++) {
        const topLeft = stack * (slices + 1) + slice;
        const topRight = topLeft + 1;
        const bottomLeft = (stack + 1) * (slices + 1) + slice;
        const bottomRight = bottomLeft + 1;
        indices[i++] = topLeft;
        indices[i++] = topRight;
        indices[i++] = bottomLeft;
        indices[i++] = bottomLeft;
        indices[i++] = topRight;
        indices[i++] = bottomRight;
      }
    }
    return { latLon, indices };
  },
} as const;

/** The two caps' constant colours (the Swift `GlobeCapPalette`). */
export interface GlobeCapPalette {
  readonly north: Rgba;
  readonly south: Rgba;
}

export const GlobeCapPalette = {
  /**
   * The colours from the style (`ImmersiveMapBaseColors`), each made opaque:
   * the caps are the planet past the last tile row, with nothing under them
   * to blend over.
   */
  make(baseColors: ImmersiveMapBaseColors): GlobeCapPalette {
    const opaque = (c: Rgba): Rgba => [c[0], c[1], c[2], 1];
    return { north: opaque(baseColors.northCap), south: opaque(baseColors.southCap) };
  },
} as const;
