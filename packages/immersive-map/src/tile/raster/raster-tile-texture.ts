// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The texture a raster tile is drawn into, a port of the Swift
 * `RasterTileTexture`: a square of the ring rule's size with its mip
 * chain, kept from frame to frame and filled again only when what it shows
 * changes, copied from the frame's atlas pass and sampled by the frame's
 * draws.
 *
 * WebGPU has no generated mipmaps (Metal's blit `generateMipmaps`). The
 * chain is drawn here by a render pass per level, a triangle over the
 * level sampling the one above bilinearly (raster-mip.wgsl). A render
 * pass and not a compute one, the simpler of the two: the texture is a
 * render target already and needs no storage usage, the sampler does the
 * 2x2 average, and the views and bind groups of every level are made once
 * with the texture.
 */

import { RASTER_TILE_TEXTURE_FORMAT, type RasterTilePipeline } from "./raster-tile-pipeline.ts";

/** The levels of a square of `size` a side, down to one texel. */
export function rasterTileMipLevelCount(size: number): number {
  return Math.floor(Math.log2(Math.max(1, size))) + 1;
}

export class RasterTileTexture {
  readonly texture: GPUTexture;
  /** The draw's group 2: the whole chain and the raster sampler. */
  readonly bindGroup: GPUBindGroup;
  /** Each level from 1 as a render target, and the bind group of the level above it. */
  private readonly levels: { target: GPUTextureView; source: GPUBindGroup }[] = [];

  constructor(
    device: GPUDevice,
    pipeline: RasterTilePipeline,
    readonly size: number,
  ) {
    const mipLevelCount = rasterTileMipLevelCount(size);
    this.texture = device.createTexture({
      label: `raster tile ${size}`,
      size: [size, size],
      format: RASTER_TILE_TEXTURE_FORMAT,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      label: `raster tile ${size}`,
      layout: pipeline.textureLayout,
      entries: [
        { binding: 0, resource: this.texture.createView() },
        { binding: 1, resource: pipeline.sampler },
      ],
    });
    for (let level = 1; level < mipLevelCount; level++) {
      this.levels.push({
        target: this.texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
        source: device.createBindGroup({
          label: `raster tile mip ${level}`,
          layout: pipeline.mipLayout,
          entries: [
            { binding: 0, resource: this.texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
            { binding: 1, resource: pipeline.mipSampler },
          ],
        }),
      });
    }
  }

  /** Draws the chain below level 0, each level from the one above. */
  encodeMips(encoder: GPUCommandEncoder, pipeline: RasterTilePipeline): void {
    for (const level of this.levels) {
      const pass = encoder.beginRenderPass({
        label: "raster tile mip",
        colorAttachments: [{ view: level.target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
      });
      pass.setPipeline(pipeline.mip);
      pass.setBindGroup(0, level.source);
      pass.draw(3);
      pass.end();
    }
  }

  destroy(): void {
    this.texture.destroy();
  }
}
