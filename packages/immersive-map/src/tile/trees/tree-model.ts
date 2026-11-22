// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The tree model the woods and the parks stand (`assets/tree_broadleaf.immtree`),
 * in the form the GPU reads it, so the file is loaded into one buffer as it
 * is and drawn from there. A port of the Swift `TreeModelContents`, whose
 * comment is the format's reference and is repeated here.
 *
 * The file is little-endian. A 24-byte header: the magic `IMTR`, the format
 * version (1), the count of levels of detail, the model's height and its
 * radius about the trunk in metres (two floats), and a reserved word. Then
 * one 16-byte entry per level, the near level first: the byte offset and
 * count of its vertices, the byte offset and count of its indices, every
 * offset from the file's start and 256-byte aligned (a buffer offset every
 * GPU takes). The geometry follows. A vertex is 20 bytes: the position in
 * metres, z up, the trunk's foot at the origin (three floats), the unit
 * normal as three signed bytes and a padding byte, and four bytes of
 * shading: how far up its part the point lies (0 at the crown's underside or
 * the trunk's foot, 255 at the top), whether the point is on the trunk (255)
 * or in the crown (0), and two reserved. The model carries no colour: the
 * frame colours it from the style (`ImmersiveMapTreePalette`). The indices
 * are 16-bit, three per triangle, wound counter-clockwise seen from outside.
 */

export interface TreeModelLevel {
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly indexOffset: number;
  readonly indexCount: number;
}

export interface TreeModelContents {
  /** The levels of detail, the near one first. */
  readonly levels: readonly TreeModelLevel[];
  readonly heightMetres: number;
  readonly radiusMetres: number;
  /** The whole file's size: what the buffer holds. */
  readonly byteCount: number;
}

/** A model file the engine cannot read. */
export class TreeModelError extends Error {
  constructor(message: string) {
    super(`The tree model is malformed: ${message}`);
    this.name = "TreeModelError";
  }
}

const magic = Object.freeze([0x49, 0x4d, 0x54, 0x52] as const);

export const TreeModelContents = {
  /** `IMTR`. */
  magic,
  formatVersion: 1,
  headerByteCount: 24,
  levelEntryByteCount: 16,
  vertexStride: 20,
  indexStride: 2,
  blockAlignment: 256,

  /** Reads the tables of a model file and checks that every level's geometry lies within the file and every index names a vertex. */
  read(bytes: ArrayBuffer): TreeModelContents {
    const C = TreeModelContents;
    if (bytes.byteLength < C.headerByteCount) throw new TreeModelError("the file is shorter than its header");
    const view = new DataView(bytes);
    for (let i = 0; i < 4; i++) {
      if (view.getUint8(i) !== magic[i]) throw new TreeModelError("the file does not start with the magic");
    }
    const version = view.getUint32(4, true);
    if (version !== C.formatVersion) throw new TreeModelError(`the file is of format version ${version}, the engine reads ${C.formatVersion}`);
    const levelCount = view.getUint32(8, true);
    if (levelCount < 1 || levelCount > 8) throw new TreeModelError(`the file holds ${levelCount} levels of detail`);
    const heightMetres = view.getFloat32(12, true);
    const radiusMetres = view.getFloat32(16, true);
    if (!(heightMetres > 0) || !Number.isFinite(heightMetres) || !(radiusMetres >= 0) || !Number.isFinite(radiusMetres)) {
      throw new TreeModelError("the model's size is not a positive number");
    }
    if (bytes.byteLength < C.headerByteCount + levelCount * C.levelEntryByteCount) throw new TreeModelError("the file is shorter than its level table");
    const levels: TreeModelLevel[] = [];
    for (let index = 0; index < levelCount; index++) {
      const entry = C.headerByteCount + index * C.levelEntryByteCount;
      const level: TreeModelLevel = {
        vertexOffset: view.getUint32(entry, true),
        vertexCount: view.getUint32(entry + 4, true),
        indexOffset: view.getUint32(entry + 8, true),
        indexCount: view.getUint32(entry + 12, true),
      };
      const fits =
        level.vertexCount > 0 &&
        level.vertexCount <= 65_536 &&
        level.indexCount > 0 &&
        level.indexCount % 3 === 0 &&
        level.vertexOffset % C.blockAlignment === 0 &&
        level.indexOffset % C.blockAlignment === 0 &&
        level.vertexOffset + level.vertexCount * C.vertexStride <= bytes.byteLength &&
        level.indexOffset + level.indexCount * C.indexStride <= bytes.byteLength;
      if (!fits) throw new TreeModelError(`level ${index} lies outside the file`);
      for (let position = 0; position < level.indexCount; position++) {
        const vertex = view.getUint16(level.indexOffset + position * C.indexStride, true);
        if (vertex >= level.vertexCount) throw new TreeModelError(`level ${index} names vertex ${vertex} of ${level.vertexCount}`);
      }
      levels.push(Object.freeze(level));
    }
    return Object.freeze({ levels: Object.freeze(levels), heightMetres, radiusMetres, byteCount: bytes.byteLength });
  },
} as const;
