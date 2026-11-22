// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A layer's mesh as one buffer: what the layers' worker builds
 * (crates/layer-mesh, `encode_file`), what the disk keeps
 * (`LayerMeshDiskCache`) and what the GPU buffers are filled from, so a mesh
 * read from the disk is laid into the GPU with nothing to parse. The port of
 * the Swift `LayerMeshFile`, with the GPU structs of this port.
 * Little-endian.
 *
 * The layout, `version` 1:
 *
 *     magic "IMLW"            4 bytes
 *     version                 u32
 *     chunk count             u32
 *     4 x (offset, size)      u64 each: fill vertices, fill indices,
 *                             line segments, discs
 *     chunks                  `chunkStride` bytes each
 *     blocks                  each at a multiple of 16 bytes
 *
 * A chunk is its tile (x, y, z as i32), its eight ranges (u32: fill index
 * start and count, line start and count, join start and count, point start
 * and count), its box in its render units and its reach in points (f32).
 * The blocks are the GPU structs (`LayerMeshLayout`). A change to this
 * layout, to a GPU struct or to what the build makes of a shape is a new
 * `version`, mirrored in crates/layer-mesh: the entries of an older one are
 * then misses and are written anew.
 */

/** The GPU structs of a mesh's blocks, mirrored by layers.wgsl and crates/layer-mesh. */
export const LayerMeshLayout = {
  /** A zone's vertex: position f32x2, colour u8x4. */
  fillVertexStride: 12,
  fillIndexStride: 4,
  /** A line's segment: start f32x2, end f32x2, width in points f32, colour u8x4 whose fourth byte is the round ends. */
  lineSegmentStride: 24,
  /** A disc: position f32x2, radius f32, ring width f32, colour u8x4, ring colour u8x4. */
  discStride: 24,
  /** The fourth byte of a segment's colour: its start is round. */
  roundStart: 1,
  /** Its end is round. */
  roundEnd: 2,
} as const;

/** The shapes of a layer whose geometry lies in one tile of the chunk zoom, the ranges into the layer's blocks (the Swift `LayerMeshChunk`). */
export interface LayerMeshChunk {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly fillIndexStart: number;
  readonly fillIndexCount: number;
  readonly lineStart: number;
  readonly lineCount: number;
  readonly joinStart: number;
  readonly joinCount: number;
  readonly pointStart: number;
  readonly pointCount: number;
  /** The box round every position of the chunk, in its render units (`LayerChunkCulling`). */
  readonly boundsMinimum: readonly [number, number];
  readonly boundsMaximum: readonly [number, number];
  /** How far past its position a line or a point of the chunk reaches on screen, in points. */
  readonly maximumReachPoints: number;
}

/** A byte range of the file. */
export interface LayerMeshBlock {
  readonly offset: number;
  readonly size: number;
}

/** Where the blocks lie in a file, and the chunks that draw from them. */
export interface LayerMeshContents {
  readonly chunks: readonly LayerMeshChunk[];
  readonly fillVertices: LayerMeshBlock;
  readonly fillIndices: LayerMeshBlock;
  readonly lineSegments: LayerMeshBlock;
  readonly discs: LayerMeshBlock;
}

export const LayerMeshFile = {
  version: 1,
  magic: "IMLW",
  blockCount: 4,
  headerSize: 12 + 4 * 16,
  chunkStride: 3 * 4 + 8 * 4 + 5 * 4,

  /**
   * Reads the header and the chunks of a file. `undefined` for a file of
   * another version, a cut one, or one whose blocks do not hold what its
   * chunks draw: a damaged file must not send the GPU out of its buffers.
   */
  decode(file: ArrayBuffer): LayerMeshContents | undefined {
    const size = file.byteLength;
    if (size < LayerMeshFile.headerSize) return undefined;
    const view = new DataView(file);
    for (let i = 0; i < 4; i++) if (view.getUint8(i) !== LayerMeshFile.magic.charCodeAt(i)) return undefined;
    if (view.getUint32(4, true) !== LayerMeshFile.version) return undefined;
    const chunkCount = view.getUint32(8, true);
    if (chunkCount >= 1 << 24 || LayerMeshFile.headerSize + chunkCount * LayerMeshFile.chunkStride > size) return undefined;
    const blocks: LayerMeshBlock[] = [];
    for (let b = 0; b < LayerMeshFile.blockCount; b++) {
      const offset = Number(view.getBigUint64(12 + b * 16, true));
      const length = Number(view.getBigUint64(20 + b * 16, true));
      if (offset > size || length > size - offset) return undefined;
      blocks.push({ offset, size: length });
    }
    const [fillVertices, fillIndices, lineSegments, discs] = blocks as [LayerMeshBlock, LayerMeshBlock, LayerMeshBlock, LayerMeshBlock];
    const fillIndexCount = Math.floor(fillIndices.size / LayerMeshLayout.fillIndexStride);
    const lineCount = Math.floor(lineSegments.size / LayerMeshLayout.lineSegmentStride);
    const discCount = Math.floor(discs.size / LayerMeshLayout.discStride);
    const chunks: LayerMeshChunk[] = [];
    for (let c = 0; c < chunkCount; c++) {
      const at = LayerMeshFile.headerSize + c * LayerMeshFile.chunkStride;
      const u = (i: number) => view.getUint32(at + 12 + i * 4, true);
      const f = (i: number) => view.getFloat32(at + 44 + i * 4, true);
      const chunk: LayerMeshChunk = {
        x: view.getInt32(at, true),
        y: view.getInt32(at + 4, true),
        z: view.getInt32(at + 8, true),
        fillIndexStart: u(0),
        fillIndexCount: u(1),
        lineStart: u(2),
        lineCount: u(3),
        joinStart: u(4),
        joinCount: u(5),
        pointStart: u(6),
        pointCount: u(7),
        boundsMinimum: [f(0), f(1)],
        boundsMaximum: [f(2), f(3)],
        maximumReachPoints: f(4),
      };
      if (
        chunk.fillIndexStart + chunk.fillIndexCount > fillIndexCount ||
        chunk.lineStart + chunk.lineCount > lineCount ||
        chunk.joinStart + chunk.joinCount > discCount ||
        chunk.pointStart + chunk.pointCount > discCount
      ) {
        return undefined;
      }
      chunks.push(chunk);
    }
    return { chunks, fillVertices, fillIndices, lineSegments, discs };
  },
} as const;
