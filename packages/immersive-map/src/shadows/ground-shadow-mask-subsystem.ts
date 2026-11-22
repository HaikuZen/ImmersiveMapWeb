// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The ground shadow mask's pass, a port of the Swift
 * `GroundShadowMaskRenderSubsystem` and `GroundShadowMaskPipeline`: one
 * fullscreen triangle at the mask's own size that samples the shadow
 * windows once a pixel on the ground plane. The frame plans the pass only
 * past the shadow gate (`ShadowFrameRuntime.plan`), so the mask and the map
 * never disagree. Single-sample: the mask is a smooth function of the
 * pixel, read once a pixel by the multisampled world pass.
 */

import type { RenderLayer } from "../render/core/render-layer.ts";
import type { RenderSubsystem } from "../render/frame-engine.ts";
import shadowLibrary from "./shaders/shadow.wgsl?raw";
import maskSource from "./shaders/ground-shadow-mask.wgsl?raw";
import { GroundShadowMask } from "./ground-shadow-mask.ts";
import type { ShadowGpuResources } from "./shadow-gpu-resources.ts";

export class GroundShadowMaskSubsystem implements RenderSubsystem {
  readonly name = "GroundShadowMask";
  readonly layers: readonly RenderLayer[] = ["groundShadowMask"];
  private readonly pipeline: GPURenderPipeline;
  private readonly layout: GPUBindGroupLayout;
  private group: { generation: number; group: GPUBindGroup } | undefined;

  constructor(
    private readonly device: GPUDevice,
    private readonly resources: ShadowGpuResources,
  ) {
    this.layout = device.createBindGroupLayout({
      label: "ground shadow mask",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      ],
    });
    const module = device.createShaderModule({ label: "ground shadow mask", code: shadowLibrary + "\n" + maskSource });
    this.pipeline = device.createRenderPipeline({
      label: "ground shadow mask",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "groundShadowMaskVertex" },
      fragment: { module, entryPoint: "groundShadowMaskFragment", targets: [{ format: GroundShadowMask.format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    if (layer !== "groundShadowMask") return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup());
    pass.draw(3);
  }

  /** The pass's bindings, built again when a shadow texture was made again. */
  private bindGroup(): GPUBindGroup {
    const generation = this.resources.generation;
    if (this.group?.generation !== generation) {
      const r = this.resources;
      this.group = {
        generation,
        group: this.device.createBindGroup({
          label: "ground shadow mask",
          layout: this.layout,
          entries: [
            { binding: 0, resource: { buffer: r.maskUniformBuffer } },
            { binding: 1, resource: { buffer: r.shadowUniformBuffer } },
            { binding: 2, resource: r.shadowMapView },
            { binding: 3, resource: r.comparisonSampler },
          ],
        }),
      };
    }
    return this.group.group;
  }
}
