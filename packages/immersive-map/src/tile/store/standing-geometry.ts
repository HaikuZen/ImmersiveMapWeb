// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * What stands on a tile, as its arena holds it (the Swift
 * `TileBuffers.extruded` and `trees` views): the extruded buildings'
 * vertices, indices and styles, and the trees' instances, read from the
 * span table once a tile and kept beside it. The spans are checked against
 * the strides here: a span that is not whole elements of its kind (a cached
 * arena of another format) draws nothing.
 */

import { EXTRUDED_VERTEX_STRIDE, TREE_INSTANCE_STRIDE } from "../pipelines/standing-pipelines.ts";
import { arenaSlots, type GpuTile, type TileArenaMeta } from "./tile-gpu.ts";

export interface ExtrudedGeometry {
  /** Byte offset and size of the vertices in the tile's buffer. */
  readonly vertexOffset: number;
  readonly vertexByteCount: number;
  /** The first index, in elements of `indexFormat`, and the count. */
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat;
  /** Byte offset and size of the styles (one vec4f colour each). */
  readonly stylesOffset: number;
  readonly stylesByteCount: number;
  /** Where each quarter's indices start, the last the count: empty for a tile kept whole (`TileQuarters`). */
  readonly quarterIndexStarts: readonly number[];
}

export interface TreeInstances {
  readonly byteOffset: number;
  readonly count: number;
  /** Where each quarter's trees start, the last the count: empty for a tile kept whole. */
  readonly quarterStarts: readonly number[];
}

export interface StandingGeometry {
  /** `undefined` for a tile without buildings. */
  readonly extruded: ExtrudedGeometry | undefined;
  /** `undefined` for a tile without trees. */
  readonly trees: TreeInstances | undefined;
}

/** The standing geometry of an arena's metadata. */
export function readStandingGeometry(meta: TileArenaMeta): StandingGeometry {
  const slots = arenaSlots(meta.textRunCounts);
  const spanOf = (kind: string) => meta.spans[slots.findIndex((slot) => slot.kind === kind)];
  const vertices = spanOf("extrudedVertices");
  const indices = spanOf("extrudedIndices");
  const styles = spanOf("extrudedStyles");
  const trees = spanOf("treeInstances");
  let extruded: ExtrudedGeometry | undefined;
  if (vertices && indices && styles && indices.elementCount > 0 && styles.byteCount >= 16 && vertices.byteCount === vertices.elementCount * EXTRUDED_VERTEX_STRIDE) {
    const width = indices.indexWidth === 2 ? 2 : 4;
    if (indices.byteOffset % width === 0) {
      extruded = {
        vertexOffset: vertices.byteOffset,
        vertexByteCount: vertices.byteCount,
        firstIndex: indices.byteOffset / width,
        indexCount: indices.elementCount,
        indexFormat: width === 2 ? "uint16" : "uint32",
        stylesOffset: styles.byteOffset,
        stylesByteCount: styles.byteCount,
        quarterIndexStarts: meta.buildingQuarterIndexStarts,
      };
    }
  }
  const treeInstances: TreeInstances | undefined =
    trees && trees.elementCount > 0 && trees.byteCount === trees.elementCount * TREE_INSTANCE_STRIDE
      ? { byteOffset: trees.byteOffset, count: trees.elementCount, quarterStarts: meta.treeQuarterStarts }
      : undefined;
  return { extruded, trees: treeInstances };
}

const cache = new WeakMap<GpuTile, StandingGeometry>();

/** A GPU tile's standing geometry, read on its first frame. */
export function standingGeometry(gpu: GpuTile): StandingGeometry {
  let geometry = cache.get(gpu);
  if (!geometry) {
    geometry = readStandingGeometry(gpu.meta);
    cache.set(gpu, geometry);
  }
  return geometry;
}
