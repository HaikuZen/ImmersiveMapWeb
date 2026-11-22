// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A model tile on the GPU, a port of the Swift `ModelTileMesh`: one vertex
 * buffer, one index buffer and one texture array for every model of the
 * tile. The vertices are in the tile's space, so the frame binds each once,
 * sets the tile's matrix, and draws the tile in one call.
 *
 * The blocks arrive from the model tile worker decoded and checked, and are
 * written to the GPU a few megabytes a frame (`ModelTileUploader`): a tile
 * of the Kremlin is some 44 MB, which a single frame would pay for in one
 * long copy. Swift loads a tile from its file by the device's IO queue. The
 * tile is handed to the store, and drawn, once every block is written.
 *
 * The texture is the archive's ASTC blocks where the device samples ASTC
 * (`texture-compression-astc`), and RGBA8 decoded in the worker elsewhere
 * (decision B14, docs/benchmarks/B14-model-textures.md). Swift draws no
 * models on a GPU without ASTC.
 */

import type { Tile } from "../../tile/tile.ts";
import type { ModelTileCullModel } from "./model-tile-culling.ts";
import type { ModelTileStoreMesh } from "./model-tile-store.ts";
import type { DecodedModelTile, ModelTileMeta, ModelTileTextureMode } from "./model-tile-worker-protocol.ts";

export class ModelTileMesh implements ModelTileStoreMesh {
  readonly tile: Tile;
  /** Every index of the tile: what one draw of the tile takes. */
  readonly indexCount: number;
  /** The tile feature ids of the map buildings the tile's models stand in for, by the zoom of the map tiles each list is for. */
  readonly replacedBuildingIDs: ReadonlyMap<number, ReadonlySet<number>>;
  /** The bounds of the whole tile, in tile space. */
  readonly boundsMinimum: readonly [number, number, number];
  readonly boundsMaximum: readonly [number, number, number];
  /**
   * The tile's models, each a range of whole triangles of the index buffer
   * with its box (`visibleModelRuns`), or none when the table does not cut
   * the index buffer into whole triangles: the tile then draws whole.
   */
  readonly models: readonly ModelTileCullModel[];
  /** The vertices' stored positions into tile space: the first matrix a vertex of the tile takes, column-major. */
  readonly positionMatrix: Float64Array;
  /** What the tile holds on the GPU, the cost the store budgets by. */
  readonly costInBytes: number;
  private destroyed = false;

  constructor(
    meta: ModelTileMeta,
    readonly vertexBuffer: GPUBuffer,
    readonly indexBuffer: GPUBuffer,
    /** What the world pass draws: the index buffer's triangles the frame keeps (`ModelTileTriangleCuller`). */
    readonly culledIndexBuffer: GPUBuffer,
    readonly texture: GPUTexture,
    /** The texture array and the sampler (`ModelPipelines.modelTileTextureLayout`). */
    readonly textureGroup: GPUBindGroup,
    textureByteCount: number,
  ) {
    this.tile = { x: meta.x, y: meta.y, z: meta.zoom };
    this.indexCount = meta.indexCount;
    this.boundsMinimum = meta.boundsMinimum;
    this.boundsMaximum = meta.boundsMaximum;
    this.positionMatrix = Float64Array.from(meta.positionMatrix);
    this.models = cullModels(meta);
    this.costInBytes = vertexBuffer.size + indexBuffer.size + culledIndexBuffer.size + textureByteCount;
    const replaced = new Map<number, Set<number>>();
    for (const [zoom, ids] of Object.entries(meta.replacedBuildingIds)) replaced.set(Number(zoom), new Set(ids));
    this.replacedBuildingIDs = replaced;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.culledIndexBuffer.destroy();
    this.texture.destroy();
  }
}

/**
 * The models of a tile as the frame culls them: in the index buffer's
 * order, or none when a model's range is not whole triangles inside the
 * buffer (the format does not promise it, and a range cut mid-triangle
 * would draw other triangles than the tile's).
 */
export function cullModels(meta: Pick<ModelTileMeta, "indexCount" | "models">): ModelTileCullModel[] {
  const models = meta.models.map((m) => ({ firstIndex: m.firstIndex, indexCount: m.indexCount, boundsMinimum: m.boundsMinimum, boundsMaximum: m.boundsMaximum }));
  const isWhole = models.every((m) => m.firstIndex % 3 === 0 && m.indexCount % 3 === 0 && m.firstIndex + m.indexCount <= meta.indexCount);
  return isWhole ? models.sort((a, b) => a.firstIndex - b.firstIndex) : [];
}

/** The GPU texture format of a decoded tile's texture: the ASTC block format, or RGBA8. `undefined` for a block edge WebGPU has no format for. */
export function modelTileTextureFormat(mode: ModelTileTextureMode, blockEdge: number): GPUTextureFormat | undefined {
  if (mode === "rgba8") return "rgba8unorm";
  switch (blockEdge) {
    case 4:
      return "astc-4x4-unorm";
    case 5:
      return "astc-5x5-unorm";
    case 6:
      return "astc-6x6-unorm";
    case 8:
      return "astc-8x8-unorm";
    case 10:
      return "astc-10x10-unorm";
    case 12:
      return "astc-12x12-unorm";
    default:
      return undefined;
  }
}

/**
 * The extent `writeTexture` takes for one level: the level's size, and for
 * a block-compressed texture its size in whole blocks (WebGPU's physical
 * size), so a level smaller than a block is written as one block.
 */
export function modelTileLevelExtent(meta: ModelTileMeta, level: number): [number, number] {
  const info = meta.texture.levels[level]!;
  if (meta.texture.format === "rgba8") return [info.width, info.height];
  const edge = meta.texture.blockEdge;
  return [Math.ceil(info.width / edge) * edge, Math.ceil(info.height / edge) * edge];
}

/** The bytes the texture's every layer of every level takes. */
export function modelTileTextureByteCount(meta: ModelTileMeta): number {
  return meta.texture.levels.reduce((sum, level) => sum + level.layerByteCount * meta.texture.layerCount, 0);
}

interface Upload {
  readonly decoded: DecodedModelTile;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly culledIndexBuffer: GPUBuffer;
  readonly texture: GPUTexture;
  readonly group: GPUBindGroup;
  /** Bytes of the vertex block written, then of the index block. */
  vertexWritten: number;
  indexWritten: number;
  textureWritten: boolean;
  readonly resolve: (mesh: ModelTileMesh) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Writes decoded model tiles to the GPU a share at a time: up to
 * `bytesPerFrame` a frame (`pump`, once a frame before the models draw), so
 * a large tile spreads over a few frames instead of stalling one. While a
 * tile is being written, the frames keep coming (`requestFrame`).
 */
export class ModelTileUploader {
  /** A frame writes this much at most: some 2 ms of copying on a laptop. */
  static readonly defaultBytesPerFrame = 12 * 1024 * 1024;
  private readonly queue: Upload[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly textureLayout: GPUBindGroupLayout,
    private readonly sampler: GPUSampler,
    private readonly requestFrame: () => void,
    private readonly bytesPerFrame = ModelTileUploader.defaultBytesPerFrame,
  ) {}

  /** Whether a tile is still being written. */
  get isUploading(): boolean {
    return this.queue.length > 0;
  }

  /** The tile's GPU objects, made now and written by the coming frames: resolves once every block is written. */
  upload(decoded: DecodedModelTile): Promise<ModelTileMesh> {
    const { meta } = decoded;
    const format = modelTileTextureFormat(meta.texture.format, meta.texture.blockEdge);
    if (format === undefined) return Promise.reject(new Error(`no texture format for ASTC ${meta.texture.blockEdge}x${meta.texture.blockEdge}`));
    const { device } = this;
    const name = `model tile ${meta.zoom}/${meta.x}/${meta.y}`;
    // The vertices and the indices are read by the triangle culling too (`ModelTileTriangleCuller`).
    const vertexBuffer = device.createBuffer({ label: `${name} vertices`, size: Math.max(16, align4(decoded.vertices.byteLength)), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const indexBuffer = device.createBuffer({ label: `${name} indices`, size: Math.max(16, decoded.indices.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const culledIndexBuffer = device.createBuffer({ label: `${name} culled indices`, size: indexBuffer.size, usage: GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE });
    const texture = device.createTexture({
      label: `${name} textures`,
      format,
      size: [meta.texture.width, meta.texture.height, meta.texture.layerCount],
      mipLevelCount: meta.texture.mipLevelCount,
      dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const group = device.createBindGroup({
      label: `${name} textures`,
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: texture.createView({ dimension: "2d-array" }) },
        { binding: 1, resource: this.sampler },
      ],
    });
    return new Promise((resolve, reject) => {
      this.queue.push({ decoded, vertexBuffer, indexBuffer, culledIndexBuffer, texture, group, vertexWritten: 0, indexWritten: 0, textureWritten: false, resolve, reject });
      this.requestFrame();
    });
  }

  /** Writes up to the frame's share, oldest tile first, and hands over every tile done. */
  pump(): void {
    let budget = this.bytesPerFrame;
    const gpuQueue = this.device.queue;
    while (this.queue.length > 0 && budget > 0) {
      const upload = this.queue[0]!;
      const { decoded } = upload;
      if (!upload.textureWritten) {
        // The texture is small next to the geometry: written whole, first.
        this.writeTexture(upload);
        upload.textureWritten = true;
        budget -= decoded.texture.byteLength;
        continue;
      }
      // Both blocks are whole words (16-byte vertices, 32-bit indices), and so is every chunk.
      const chunkLimit = Math.max(4, Math.floor(budget / 4) * 4);
      const vertexRemaining = decoded.vertices.byteLength - upload.vertexWritten;
      if (vertexRemaining > 0) {
        const chunk = Math.min(vertexRemaining, chunkLimit);
        gpuQueue.writeBuffer(upload.vertexBuffer, upload.vertexWritten, decoded.vertices.buffer, decoded.vertices.byteOffset + upload.vertexWritten, chunk);
        upload.vertexWritten += chunk;
        budget -= chunk;
        continue;
      }
      const indexRemaining = decoded.indices.byteLength - upload.indexWritten;
      if (indexRemaining > 0) {
        const chunk = Math.min(indexRemaining, chunkLimit);
        gpuQueue.writeBuffer(upload.indexBuffer, upload.indexWritten, decoded.indices.buffer, decoded.indices.byteOffset + upload.indexWritten, chunk);
        upload.indexWritten += chunk;
        budget -= chunk;
        continue;
      }
      this.queue.shift();
      upload.resolve(new ModelTileMesh(decoded.meta, upload.vertexBuffer, upload.indexBuffer, upload.culledIndexBuffer, upload.texture, upload.group, modelTileTextureByteCount(decoded.meta)));
    }
    if (this.queue.length > 0) this.requestFrame();
  }

  /** Drops every tile not yet written, its GPU objects destroyed. */
  destroy(): void {
    for (const upload of this.queue.splice(0)) {
      upload.vertexBuffer.destroy();
      upload.indexBuffer.destroy();
      upload.culledIndexBuffer.destroy();
      upload.texture.destroy();
      upload.reject(new Error("the model tile uploader was destroyed"));
    }
  }

  private writeTexture(upload: Upload): void {
    const { meta, texture } = upload.decoded;
    for (let level = 0; level < meta.texture.mipLevelCount; level++) {
      const info = meta.texture.levels[level]!;
      const [width, height] = modelTileLevelExtent(meta, level);
      for (let layer = 0; layer < meta.texture.layerCount; layer++) {
        this.device.queue.writeTexture(
          { texture: upload.texture, mipLevel: level, origin: [0, 0, layer] },
          texture.buffer,
          { offset: texture.byteOffset + info.byteOffset + layer * info.layerByteCount, bytesPerRow: info.bytesPerRow, rowsPerImage: info.rowsPerImage },
          [width, height, 1],
        );
      }
    }
  }
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}
