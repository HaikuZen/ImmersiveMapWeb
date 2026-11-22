// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * FXAA over the finished world pass, a port of the Swift
 * `PostProcessingRenderSubsystem` and `FXAAPipeline`: one fullscreen
 * triangle from the post-processing input (`FrameEngine.postProcessingInput`,
 * the world pass's colour, resolved when it is multisampled) into the
 * drawable. The engine runs the pass only with FXAA on
 * (`planRenderFrameOutput`), and the overlay draws over its result.
 */

import type { RenderLayer } from "../core/render-layer.ts";
import type { RenderSubsystem } from "../frame-engine.ts";
import fxaaSource from "./shaders/fxaa.wgsl?raw";

export class PostProcessingSubsystem implements RenderSubsystem {
  readonly name = "PostProcessing";
  readonly layers: readonly RenderLayer[] = ["postProcessing"];
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private group: { texture: GPUTexture; group: GPUBindGroup } | undefined;

  constructor(
    private readonly device: GPUDevice,
    colorFormat: GPUTextureFormat,
    private readonly input: () => GPUTexture | undefined,
  ) {
    const module = device.createShaderModule({ label: "fxaa", code: fxaaSource });
    this.pipeline = device.createRenderPipeline({
      label: "fxaa",
      layout: "auto",
      vertex: { module, entryPoint: "postProcessingVertex" },
      fragment: { module, entryPoint: "fxaaFragment", targets: [{ format: colorFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this.sampler = device.createSampler({ label: "fxaa", minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    const texture = this.input();
    if (layer !== "postProcessing" || !texture) return;
    if (this.group?.texture !== texture) {
      this.group = {
        texture,
        group: this.device.createBindGroup({
          label: "fxaa",
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: this.sampler },
          ],
        }),
      };
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group.group);
    pass.draw(3);
  }
}
