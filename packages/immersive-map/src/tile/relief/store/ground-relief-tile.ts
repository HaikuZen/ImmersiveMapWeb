// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ClosedRange } from "../../../math/closed-range.ts";
import { halfBitsToFloat } from "./half-float.ts";
import type { GroundReliefOcclusionKey } from "./ground-relief-occlusion.ts";

/**
 * A texture of the relief as the store holds it: the GPU's (`view`) in the
 * map, nothing in a test. `id` names it for the bind groups that read it.
 */
export interface ReliefTexture {
  readonly id: number;
  readonly view?: GPUTextureView;
  /** Bytes it takes on the GPU. */
  readonly byteLength: number;
}

/** A tile's four edges, `size` texels each: the north and the south rows west to east, the west and the east columns north to south. */
export interface GroundReliefTileEdges {
  readonly north: Uint16Array;
  readonly south: Uint16Array;
  readonly west: Uint16Array;
  readonly east: Uint16Array;
}

let nextTileId = 1;

/**
 * One terrain tile's heights, a port of the Swift `GroundReliefTile`: as
 * half floats in an `r16float` texture for the GPU, and the same halves on
 * the CPU for what is placed by it there (the camera, the labels, the
 * buildings' lifts). Half floats filter on every GPU, so the vertex stage
 * takes one bilinear sample, and they step by half a metre at 1000 m and 2
 * m at 4000 m, well under the ground's grid.
 *
 * The edges are welded to the neighbours' of the same zoom once they are
 * in (`GroundReliefEdgeWeld`): the texels along an edge take the mean of
 * the tile's and its neighbour's, the height that lies on the edge itself,
 * so two tiles meet there with one height and the ground drawn over them
 * closes. The texels change in place, written at a frame's start
 * (`GroundReliefStore.applyPendingWelds`). Main thread only.
 */
export class GroundReliefTile {
  /** Names the tile for the bind groups and the lifts made from it. */
  readonly id = nextTileId++;
  /** The tile's occlusion of the sky (`GroundReliefOcclusion`) and the key it was computed with, `undefined` until computed. */
  private occlusionTexture: ReliefTexture | undefined;
  private occlusionKeyValue: GroundReliefOcclusionKey | undefined;
  /** The edges as decoded, which every weld averages from, so the weld is the same whatever order the neighbours came in. */
  readonly originalEdges: GroundReliefTileEdges;
  private range: ClosedRange;
  private revisionValue = 0;

  /**
   * `texture` is the heights on the GPU (`r16float`, row 0 at the north
   * edge), `halves` the same texels row by row, `heightRange` the lowest
   * and the highest height in metres.
   */
  constructor(
    readonly texture: ReliefTexture,
    readonly size: number,
    readonly halves: Uint16Array,
    heightRange: ClosedRange,
  ) {
    this.range = heightRange;
    const west = new Uint16Array(size);
    const east = new Uint16Array(size);
    for (let row = 0; row < size; row++) {
      west[row] = halves[row * size]!;
      east[row] = halves[row * size + size - 1]!;
    }
    this.originalEdges = {
      north: halves.slice(0, size),
      south: halves.slice((size - 1) * size, size * size),
      west,
      east,
    };
  }

  /** The lowest and the highest height in the tile, in metres, the welded edges included. */
  get heightRange(): ClosedRange {
    return this.range;
  }

  /** Grows with every weld written into the texels: what was placed by them on the CPU (the buildings' lifts) is placed again. */
  get revision(): number {
    return this.revisionValue;
  }

  get occlusion(): ReliefTexture | undefined {
    return this.occlusionTexture;
  }

  get occlusionKey(): GroundReliefOcclusionKey | undefined {
    return this.occlusionKeyValue;
  }

  setOcclusion(texture: ReliefTexture | undefined, key: GroundReliefOcclusionKey | undefined): void {
    this.occlusionTexture = texture;
    this.occlusionKeyValue = key;
  }

  /** What it costs in memory: the texture, the halves and the edges on the CPU, and the occlusion. */
  get costInBytes(): number {
    return this.texture.byteLength + (this.halves.length + this.size * 4) * 2 + (this.occlusionTexture?.byteLength ?? 0);
  }

  /** The decoded texel at a corner, `x` and `y` each 0 or `size - 1`. */
  originalCorner(x: number, y: number): number {
    const row = y === 0 ? this.originalEdges.north : this.originalEdges.south;
    return row[x]!;
  }

  /**
   * Writes texels of a welded edge on the CPU, a rectangle of `width` by
   * `height` from the column `x` and the row `y`, row by row: the texture
   * takes the same at the frame's start.
   */
  writeTexels(values: ArrayLike<number>, x: number, y: number, width: number, height: number): void {
    let lowest = this.range.lowerBound;
    let highest = this.range.upperBound;
    const size = this.size;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const value = values[row * width + column]!;
        this.halves[(y + row) * size + x + column] = value;
        const metres = halfBitsToFloat(value);
        lowest = Math.min(lowest, metres);
        highest = Math.max(highest, metres);
      }
    }
    this.range = { lowerBound: lowest, upperBound: highest };
    this.revisionValue += 1;
  }

  /**
   * The height in metres at a point of the texture, in 0 to 1, bilinear
   * between the four texels around it, the texels at the edge repeating
   * outward as the sampler clamps.
   */
  metresAtTextureUV(u: number, v: number): number {
    const size = this.size;
    const last = size - 1;
    const tx = Math.min(Math.max(u * size - 0.5, 0), last);
    const ty = Math.min(Math.max(v * size - 0.5, 0), last);
    const lowerX = Math.trunc(tx);
    const lowerY = Math.trunc(ty);
    const upperX = Math.min(lowerX + 1, last);
    const upperY = Math.min(lowerY + 1, last);
    const blendX = tx - lowerX;
    const blendY = ty - lowerY;
    const halves = this.halves;
    const northWest = halfBitsToFloat(halves[lowerY * size + lowerX]!);
    const northEast = halfBitsToFloat(halves[lowerY * size + upperX]!);
    const southWest = halfBitsToFloat(halves[upperY * size + lowerX]!);
    const southEast = halfBitsToFloat(halves[upperY * size + upperX]!);
    const north = northWest + (northEast - northWest) * blendX;
    const south = southWest + (southEast - southWest) * blendX;
    return north + (south - north) * blendY;
  }
}
