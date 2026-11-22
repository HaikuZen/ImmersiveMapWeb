// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The GPU side of the shadows (the shadow half of the Swift
 * `FrameAttachmentStore` and `SharedRenderResources`): the shadow map, one
 * square depth texture with a slice a window (`ShadowCascadeAtlas`), the
 * ground shadow mask at a share of the drawable (`GroundShadowMask`), the
 * frame's shadow uniform every receiver reads, the mask pass's uniform, and
 * the samplers. A 1x1 fallback stands in for a texture the frame has not
 * needed yet, so a receiver's bind group is always whole.
 *
 * `generation` changes whenever a texture is made again: a bind group built
 * on the old one is built again by its owner.
 */

import { GroundShadowMask, GroundShadowMaskUniformLayout } from "./ground-shadow-mask.ts";
import { ShadowCascadeAtlas, type ShadowCascadeSlot } from "./shadow-cascade-atlas.ts";
import { ShadowUniformLayout } from "./shadow-uniform.ts";

export class ShadowGpuResources {
  /** The frame's shadow uniform (shadow.wgsl `Shadow`), the disabled one on a frame without shadows. */
  readonly shadowUniformBuffer: GPUBuffer;
  /** The mask pass's uniform (ground-shadow-mask.wgsl `GroundShadowMaskUniform`). */
  readonly maskUniformBuffer: GPUBuffer;
  /** The tent's compares (less-equal: lit where the reference is not past the stored depth). */
  readonly comparisonSampler: GPUSampler;
  /** The mask's bilinear upsampling. */
  readonly maskSampler: GPUSampler;
  private shadowMap: GPUTexture;
  private shadowMapArrayView: GPUTextureView;
  private sliceViews: GPUTextureView[];
  private mask: GPUTexture;
  private maskView: GPUTextureView;
  private generationCounter = 0;
  private shadowMapIdentity = 0;
  /** Whether `shadowMap` is the fallback, not a map a pass has drawn. */
  private shadowMapIsFallback = true;
  private maskIsFallback = true;
  /** Writes the far depth over a slice's scissor rectangle (`encodeRegionClear`), made on its first use. */
  private regionClear: GPURenderPipeline | undefined;

  constructor(private readonly device: GPUDevice) {
    this.shadowUniformBuffer = device.createBuffer({ label: "shadow", size: ShadowUniformLayout.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.maskUniformBuffer = device.createBuffer({ label: "ground shadow mask", size: GroundShadowMaskUniformLayout.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.comparisonSampler = device.createSampler({
      label: "shadow compare",
      compare: "less-equal",
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.maskSampler = device.createSampler({ label: "ground shadow mask", minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    [this.shadowMap, this.shadowMapArrayView, this.sliceViews] = this.makeShadowMap(1);
    [this.mask, this.maskView] = this.makeMask(1, 1);
    // The fallback mask is lit: a frame that reads it by mistake shows no shadow.
    device.queue.writeTexture({ texture: this.mask }, new Uint8Array([255]), { bytesPerRow: 256 }, [1, 1]);
  }

  /** Changes whenever a texture is made again. */
  get generation(): number {
    return this.generationCounter;
  }

  /** Every slice of the shadow map, as the receivers sample it. */
  get shadowMapView(): GPUTextureView {
    return this.shadowMapArrayView;
  }

  /** The ground shadow mask, as the ground samples it. */
  get groundShadowMaskView(): GPUTextureView {
    return this.maskView;
  }

  /**
   * The shadow map at `resolution` texels a side, made again when the size
   * differs. Returns its identity for the reuse controller: a map made
   * again is blank, and every window renders into it again.
   */
  ensureShadowMap(resolution: number): number {
    if (this.shadowMapIsFallback || this.shadowMap.width !== resolution) {
      this.shadowMap.destroy();
      [this.shadowMap, this.shadowMapArrayView, this.sliceViews] = this.makeShadowMap(resolution);
      this.shadowMapIsFallback = false;
      this.generationCounter++;
      this.shadowMapIdentity++;
    }
    return this.shadowMapIdentity;
  }

  /** The view a window's caster pass draws into. */
  sliceView(slot: ShadowCascadeSlot): GPUTextureView {
    return this.sliceViews[ShadowCascadeAtlas.slice(slot)]!;
  }

  /** The mask for a drawable of this size (`GroundShadowMask.maskSize`), made again when it differs. Returns its view and size. */
  ensureGroundShadowMask(drawWidth: number, drawHeight: number): { view: GPUTextureView; width: number; height: number } {
    const [width, height] = GroundShadowMask.maskSize(drawWidth, drawHeight);
    if (this.maskIsFallback || this.mask.width !== width || this.mask.height !== height) {
      this.mask.destroy();
      [this.mask, this.maskView] = this.makeMask(width, height);
      this.maskIsFallback = false;
      this.generationCounter++;
    }
    return { view: this.maskView, width, height };
  }

  /**
   * Sets the scissor of a caster pass over a kept slice to `scissor` (x, y,
   * width, height in texels) and clears the depth inside it, so the
   * casters drawn next make that rectangle again from nothing.
   */
  encodeRegionClear(pass: GPURenderPassEncoder, scissor: readonly [number, number, number, number]): void {
    this.regionClear ??= this.device.createRenderPipeline({
      label: "shadow region clear",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [] }),
      vertex: { module: this.device.createShaderModule({ label: "shadow region clear", code: regionClearSource }), entryPoint: "shadowRegionClearVertex" },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ShadowCascadeAtlas.depthFormat, depthWriteEnabled: true, depthCompare: "always" },
    });
    pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
    pass.setPipeline(this.regionClear);
    pass.draw(3);
  }

  destroy(): void {
    this.shadowMap.destroy();
    this.mask.destroy();
    this.shadowUniformBuffer.destroy();
    this.maskUniformBuffer.destroy();
  }

  private makeShadowMap(resolution: number): [GPUTexture, GPUTextureView, GPUTextureView[]] {
    const texture = this.device.createTexture({
      label: "shadow map",
      size: [resolution, resolution, ShadowCascadeAtlas.sliceCount],
      format: ShadowCascadeAtlas.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const arrayView = texture.createView({ dimension: "2d-array" });
    const slices = Array.from({ length: ShadowCascadeAtlas.sliceCount }, (_, layer) => texture.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1 }));
    return [texture, arrayView, slices];
  }

  private makeMask(width: number, height: number): [GPUTexture, GPUTextureView] {
    const texture = this.device.createTexture({
      label: "ground shadow mask",
      size: [width, height],
      format: GroundShadowMask.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    return [texture, texture.createView()];
  }
}

/** A triangle over the whole slice at the far depth: the scissor keeps it to the region. */
const regionClearSource = /* wgsl */ `
@vertex
fn shadowRegionClearVertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    return vec4f(positions[vertexIndex], 1.0, 1.0);
}
`;
