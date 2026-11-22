// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Tile } from "../../tile.ts";
import type { GroundRelief } from "../lifts/ground-relief.ts";
import type { GroundReliefOcclusionKey } from "../store/ground-relief-occlusion.ts";
import type { GroundReliefTextures } from "../store/ground-relief-store.ts";
import type { GroundReliefTile, ReliefTexture } from "../store/ground-relief-tile.ts";
import type { GroundReliefFrame } from "./ground-relief-frame.ts";
import { GroundReliefUniform } from "./ground-relief-uniform.ts";

/** A relief texture on the GPU. */
export interface GpuReliefTexture extends ReliefTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
}

/**
 * Where decision B10 computes a tile's occlusion of the sky: on the GPU,
 * from the tile's heights texture, into an `r8unorm` texture of the key's
 * resolution (`GroundReliefOcclusionGpu.compute`).
 */
export type GroundReliefOcclusionCompute = (heights: GPUTexture, tile: Tile, key: GroundReliefOcclusionKey) => GPUTexture;

/** The slot a draw's uniform takes in the frame's buffer: the dynamic offset's alignment. */
const UNIFORM_SLOT_BYTES = 256;
const UNIFORM_SLOT_FLOATS = UNIFORM_SLOT_BYTES / 4;

let nextTextureId = 1;

/**
 * The layout of the relief's group (ground-relief.wgsl): the uniform at a
 * dynamic offset, the heights the vertex stage rises by, the heights and
 * the occlusion the fragment stage shades by, and the sampler.
 */
export function groundReliefBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  return device.createBindGroupLayout({
    label: "ground relief",
    entries: [
      { binding: 0, visibility: both, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: GroundReliefUniform.byteLength } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: both, sampler: { type: "filtering" } },
    ],
  });
}

/**
 * The GPU side of the ground relief, which every draw that rises by it
 * binds as its group 3 (ground-relief.wgsl), the WebGPU stand-in for the
 * Swift `GroundReliefUniform.bind`: the uniform at a dynamic offset into the
 * frame's buffer, the terrain the grid rises by (the vertex stage's), the
 * terrain the slopes are shaded by and its occlusion of the sky (the
 * fragment stage's), and the sampler. A bind group is kept for each set of
 * textures and made again only when the uniform's buffer grows. A frame off
 * the relief binds `empty`, which no draw reads.
 *
 * It also makes the store's textures (`GroundReliefTextures`): the heights
 * as `r16float`, the occlusion as `r8unorm`, both released after the frame
 * that may still read them is submitted (`frameCommitted`).
 */
export class GroundReliefGpu implements GroundReliefTextures {
  readonly layout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;
  /** One texel of no darkening, for a tile whose occlusion is not computed. */
  readonly occlusionFallback: GpuReliefTexture;
  private readonly flatHeights: GpuReliefTexture;
  private buffer: GPUBuffer;
  private staging: Float32Array<ArrayBuffer>;
  private capacity: number;
  private used = 0;
  private bufferGeneration = 0;
  private readonly groups = new Map<string, { generation: number; group: GPUBindGroup }>();
  private emptyGroup: { generation: number; group: GPUBindGroup } | undefined;
  private released: GPUTexture[] = [];
  private retiredBuffers: GPUBuffer[] = [];

  /** The relief's group layout (`groundReliefBindGroupLayout`), shared with the pipelines that rise by it. */
  constructor(
    private readonly device: GPUDevice,
    readonly layoutOfGroup: GPUBindGroupLayout,
    private readonly computeOcclusion: GroundReliefOcclusionCompute | undefined = undefined,
  ) {
    this.layout = layoutOfGroup;
    this.sampler = device.createSampler({ label: "ground relief", minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.occlusionFallback = this.texture("ground relief occlusion fallback", "r8unorm", 1, new Uint8Array([0]), 1);
    this.flatHeights = this.texture("ground relief flat", "r16float", 1, new Uint16Array([0]), 2);
    this.capacity = 64;
    this.buffer = this.makeBuffer(this.capacity);
    this.staging = new Float32Array(this.capacity * UNIFORM_SLOT_FLOATS);
  }

  // MARK: The store's textures

  heights(size: number, halves: Uint16Array): ReliefTexture {
    return this.texture("ground relief heights", "r16float", size, halves, 2);
  }

  writeHeights(texture: ReliefTexture, x: number, y: number, width: number, height: number, values: Uint16Array<ArrayBuffer>): void {
    const target = (texture as GpuReliefTexture).texture;
    this.device.queue.writeTexture({ texture: target, origin: { x, y } }, values, { bytesPerRow: width * 2, rowsPerImage: height }, [width, height]);
  }

  /**
   * A tile's occlusion of the sky, computed on the GPU from the tile's
   * heights (decision B10), queued before the frame that first draws it.
   * `milliseconds` is the main thread's encode, the GPU's own time is in
   * docs/benchmarks/B10-occlusion.md.
   */
  occlusion(tile: Tile, terrain: GroundReliefTile, key: GroundReliefOcclusionKey): { texture: ReliefTexture; milliseconds: number } | undefined {
    if (!(key.resolution > 0 && key.radiusMetres > 0) || this.computeOcclusion === undefined) return undefined;
    const heights = (terrain.texture as GpuReliefTexture).texture;
    const started = performance.now();
    const texture = this.computeOcclusion(heights, tile, key);
    const milliseconds = performance.now() - started;
    const occlusion: GpuReliefTexture = { id: nextTextureId++, texture, view: texture.createView(), byteLength: key.resolution * key.resolution };
    return { texture: occlusion, milliseconds };
  }

  release(texture: ReliefTexture): void {
    this.released.push((texture as GpuReliefTexture).texture);
  }

  // MARK: The frame's draws

  /** Starts a frame: every uniform slot is free again. */
  beginFrame(): void {
    this.used = 0;
  }

  /**
   * Binds the relief of one tile for a draw that rises by it, at group
   * `index` of `pass`: `relief` the terrain the grid rises by, `shading` the
   * one the slopes are shaded by (`relief` when the same), over `tile`, with
   * the frame's datum, rise, shading and darkening.
   */
  bind(pass: GPURenderPassEncoder, index: number, relief: GroundRelief, shading: GroundRelief | undefined, tile: Tile, frame: GroundReliefFrame, renderMapSize: number): void {
    const shade = shading ?? relief;
    if (this.used >= this.capacity) this.grow(this.capacity * 2);
    const slot = this.used++;
    GroundReliefUniform.write(this.staging, slot * UNIFORM_SLOT_FLOATS, relief, shade, tile, frame, renderMapSize);
    const heights = relief.texture as GpuReliefTexture;
    const shadingHeights = shade.texture as GpuReliefTexture;
    const occlusion = (shade.occlusion as GpuReliefTexture | undefined) ?? this.occlusionFallback;
    pass.setBindGroup(index, this.group(heights, shadingHeights, occlusion), [slot * UNIFORM_SLOT_BYTES]);
  }

  /** The group of a draw that reads no relief (the plane's variant of a pipeline whose layout has the relief's group). */
  bindEmpty(pass: GPURenderPassEncoder, index: number): void {
    if (this.emptyGroup?.generation !== this.bufferGeneration) {
      this.emptyGroup = { generation: this.bufferGeneration, group: this.makeGroup(this.flatHeights, this.flatHeights, this.occlusionFallback) };
    }
    pass.setBindGroup(index, this.emptyGroup.group, [0]);
  }

  /** Writes the frame's uniforms, before the frame's submit. */
  flush(): void {
    if (this.used > 0) this.device.queue.writeBuffer(this.buffer, 0, this.staging, 0, this.used * UNIFORM_SLOT_FLOATS);
  }

  /** After the frame's submit: the textures the store let go of and the outgrown buffers go now. */
  frameCommitted(): void {
    for (const texture of this.released) texture.destroy();
    this.released = [];
    for (const buffer of this.retiredBuffers) buffer.destroy();
    this.retiredBuffers = [];
    // The groups of textures no longer held are dropped as the store lets them go.
    if (this.groups.size > 512) this.groups.clear();
  }

  destroy(): void {
    this.frameCommitted();
    this.buffer.destroy();
    this.occlusionFallback.texture.destroy();
    this.flatHeights.texture.destroy();
    this.groups.clear();
  }

  private group(heights: GpuReliefTexture, shading: GpuReliefTexture, occlusion: GpuReliefTexture): GPUBindGroup {
    const key = `${heights.id}/${shading.id}/${occlusion.id}`;
    const known = this.groups.get(key);
    if (known !== undefined && known.generation === this.bufferGeneration) return known.group;
    const group = this.makeGroup(heights, shading, occlusion);
    this.groups.set(key, { generation: this.bufferGeneration, group });
    return group;
  }

  private makeGroup(heights: GpuReliefTexture, shading: GpuReliefTexture, occlusion: GpuReliefTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: "ground relief",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer, size: GroundReliefUniform.byteLength } },
        { binding: 1, resource: heights.view },
        { binding: 2, resource: shading.view },
        { binding: 3, resource: occlusion.view },
        { binding: 4, resource: this.sampler },
      ],
    });
  }

  private grow(capacity: number): void {
    // The draws encoded so far read the old buffer: it keeps its slots, is
    // written at the flush with them, and goes after the submit.
    const old = this.buffer;
    const oldStaging = this.staging;
    this.device.queue.writeBuffer(old, 0, oldStaging, 0, this.used * UNIFORM_SLOT_FLOATS);
    this.retiredBuffers.push(old);
    this.capacity = capacity;
    this.buffer = this.makeBuffer(capacity);
    this.staging = new Float32Array(capacity * UNIFORM_SLOT_FLOATS);
    this.staging.set(oldStaging);
    this.bufferGeneration += 1;
  }

  private makeBuffer(slots: number): GPUBuffer {
    return this.device.createBuffer({ label: "ground relief uniforms", size: slots * UNIFORM_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private texture(label: string, format: "r16float" | "r8unorm", size: number, data: Uint16Array | Uint8Array, bytesPerTexel: number): GpuReliefTexture {
    const texture = this.device.createTexture({ label, size: [size, size], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture }, data as Uint16Array<ArrayBuffer>, { bytesPerRow: size * bytesPerTexel, rowsPerImage: size }, [size, size]);
    return { id: nextTextureId++, texture, view: texture.createView(), byteLength: size * size * bytesPerTexel };
  }
}
