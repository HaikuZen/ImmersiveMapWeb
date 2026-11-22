// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A tile's screen labels as the frame reads them: the placement records of
 * its metadata (`TextLabelSetMeta.placementInputs`) laid out once, when the
 * tile is made, as columns the working set copies runs of, and the tile's
 * labels in collision rank order (the Swift `TileBuffers.TextLabelSet` with
 * its `rankOrder`: ranked here, so a working set merges its tiles' orders
 * instead of sorting every label it holds).
 *
 * The labels keep the parser's order: by the zoom they show from, then the
 * collision priority, then the sort key. `LabelActiveSpans` searches that
 * order for the head a camera zoom shows.
 */

import type { TextLabelSetMeta } from "../../tile/store/prepared-labels.ts";
import { type BaseLabelRanks, clampInt32, keyHalves, makeBaseLabelRanks, parseLabelKey, sortedRankOrder } from "../collisions/base-label-rank.ts";

export interface TileTextLabels {
  readonly count: number;
  /** The anchor as a share of the tile, (0, 0) north-west, two per label. */
  readonly uv: Float32Array;
  /** The roof over the anchor in tile units (a 4096 extent), zero on open ground. */
  readonly roofHeight: Float32Array;
  /** 1 where the label draws on that roof. */
  readonly liftsToRoof: Uint8Array;
  /** The collision box in layout points, two per label. */
  readonly sizePoints: Float32Array;
  readonly ranks: BaseLabelRanks;
  /** The label's identity across tiles and zooms, 0 for none. */
  readonly keys: BigUint64Array;
  readonly minCameraZoom: Float32Array;
  /** Infinity for never. */
  readonly maxCameraZoom: Float32Array;
  readonly isLocal: Uint8Array;
  /** The labels' indices in collision rank order. */
  readonly rankOrder: Int32Array;
}

/** The columns of a tile's label set. */
export function makeTileTextLabels(meta: TextLabelSetMeta): TileTextLabels {
  const inputs = meta.placementInputs;
  const count = inputs.length;
  const uv = new Float32Array(count * 2);
  const roofHeight = new Float32Array(count);
  const liftsToRoof = new Uint8Array(count);
  const sizePoints = new Float32Array(count * 2);
  const ranks = makeBaseLabelRanks(count);
  const keys = new BigUint64Array(count);
  const minCameraZoom = new Float32Array(count);
  const maxCameraZoom = new Float32Array(count);
  const isLocal = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const input = inputs[index]!;
    uv[index * 2] = input.uv[0];
    uv[index * 2 + 1] = input.uv[1];
    roofHeight[index] = input.roofHeight;
    liftsToRoof[index] = input.liftsToRoof ? 1 : 0;
    sizePoints[index * 2] = input.labelSizePoints[0];
    sizePoints[index * 2 + 1] = input.labelSizePoints[1];
    const key = parseLabelKey(input.key);
    keys[index] = key;
    const [hi, lo] = keyHalves(key);
    ranks.priority[index] = clampInt32(input.collisionPriority);
    ranks.sortPriority[index] = clampInt32(input.sortKey);
    ranks.keyHi[index] = hi;
    ranks.keyLo[index] = lo;
    minCameraZoom[index] = input.minCameraZoom;
    maxCameraZoom[index] = input.maxCameraZoom ?? Infinity;
    isLocal[index] = input.isLocal ? 1 : 0;
  }
  return { count, uv, roofHeight, liftsToRoof, sizePoints, ranks, keys, minCameraZoom, maxCameraZoom, isLocal, rankOrder: sortedRankOrder(ranks, count) };
}
