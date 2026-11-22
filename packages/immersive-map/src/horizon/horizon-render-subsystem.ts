// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { RenderCamera } from "../camera/render-camera.ts";
import type { RenderLayer } from "../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import type { SceneFrameState } from "../render/scene-frame-state.ts";
import { TileSourceStencilPriority } from "../tile/drawers/depth-rank.ts";
import { HorizonBandMath, type HorizonHaze, HorizonFrameResolver } from "./horizon-frame-resolver.ts";
import { HorizonUniformLayout, writeHorizonUniform } from "./horizon-uniform.ts";
import horizonSource from "./shaders/horizon.wgsl?raw";

/** The GPU the horizon draws into. */
export interface HorizonPipelineContext {
  readonly device: GPUDevice;
  readonly colorFormat: GPUTextureFormat;
  readonly depthStencilFormat: GPUTextureFormat;
  readonly sampleCount: number;
}

/**
 * Premultiplied "over": the shader hands out the tint already weighted by
 * its coverage, and the coverage in alpha, so the haze covers the edge and
 * thins to nothing away from it. Alpha composes the same way, which keeps
 * the frame's own coverage right where space is transparent.
 */
const premultipliedOver: GPUBlendState = {
  color: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

/**
 * The pass that paints the air around the surface's edge, a port of the
 * Swift `HorizonPipeline` and `HorizonRenderer`: one shading function
 * behind a side constant, two pipelines (in WebGPU the depth-stencil state
 * is the pipeline's), one geometry, the band. The sky side tests the far
 * plane less-equal against the cleared depth (the Swift
 * `skyBackdropDepthState`), the ground side greater, and not where a
 * building or a model raised the surface mask bit (the Swift
 * `horizonGroundDepthState`, reference 0 through a mask of the bit alone).
 */
export class HorizonPipeline {
  readonly layout: GPUBindGroupLayout;
  readonly sky: GPURenderPipeline;
  readonly ground: GPURenderPipeline;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;

  constructor(context: HorizonPipelineContext) {
    const { device, colorFormat, depthStencilFormat, sampleCount } = context;
    this.layout = device.createBindGroupLayout({
      label: "horizon",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { minBindingSize: HorizonUniformLayout.byteLength } }],
    });
    const module = device.createShaderModule({ label: "horizon", code: horizonSource });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const make = (groundSide: boolean): GPURenderPipeline => {
      const constants = { kHorizonGroundSide: groundSide ? 1 : 0 };
      const keep: GPUStencilFaceState = { compare: groundSide ? "equal" : "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
      return device.createRenderPipeline({
        label: groundSide ? "horizon ground" : "horizon sky",
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: "horizonBandVertex",
          constants,
          buffers: [
            {
              arrayStride: 8,
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32" },
                { shaderLocation: 1, offset: 4, format: "float32" },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: "horizonBandFragment", constants, targets: [{ format: colorFormat, blend: premultipliedOver }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: depthStencilFormat,
          depthWriteEnabled: false,
          depthCompare: groundSide ? "greater" : "less-equal",
          stencilFront: keep,
          stencilBack: keep,
          stencilReadMask: groundSide ? TileSourceStencilPriority.surfaceMaskBit : 0,
          stencilWriteMask: 0,
        },
        multisample: { count: sampleCount },
      });
    };
    this.sky = make(false);
    this.ground = make(true);
    const mesh = HorizonBandMath.mesh();
    this.vertexBuffer = device.createBuffer({ label: "horizon band vertices", size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices);
    this.indexBuffer = device.createBuffer({ label: "horizon band indices", size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);
    this.indexCount = mesh.indices.length;
  }
}

/**
 * The air around the surface's edge, drawn last in the world pass on both
 * surfaces, a port of the Swift `HorizonRenderSubsystem`: the globe's
 * atmosphere and limb feather, on the unrolling surface too, handing over
 * to the flat map's sky at the end of the morph (`HorizonFrameResolver`).
 * The flat map's far ground is veiled by the ground fog, not here.
 *
 * Up to two draws of the band split by the depth buffer, each pixel shaded
 * once. Both are skipped when the edge is farther below the frame than the
 * air reaches, which at street pitch is every frame. Transparent space
 * skips the globe's sky draw, while the plane's sky still paints over its
 * own clear colour.
 */
export class HorizonRenderSubsystem implements RenderSubsystem {
  readonly name = "Horizon";
  readonly layers: readonly RenderLayer[] = ["horizon"];
  private readonly pipeline: HorizonPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly staging = new Float32Array(HorizonUniformLayout.byteLength / 4);
  private haze: HorizonHaze | undefined;

  constructor(
    private readonly gpu: HorizonPipelineContext,
    private readonly state: () => SceneFrameState | undefined,
  ) {
    this.pipeline = new HorizonPipeline(gpu);
    this.uniformBuffer = gpu.device.createBuffer({ label: "horizon", size: HorizonUniformLayout.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = gpu.device.createBindGroup({ label: "horizon", layout: this.pipeline.layout, entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] });
  }

  /** The frame's haze, resolved from the settings, the transition and the camera. */
  static resolveHaze(scene: SceneFrameState, drawHeight: number): HorizonHaze {
    const { cameraFrame, presentation } = scene;
    return HorizonFrameResolver.resolve({
      settings: scene.settings,
      mapColor: scene.mapColor,
      transition: presentation.presentationState.transition,
      // The air follows the camera's zoom over time (`AnimatedZoom`).
      zoom: scene.animatedZoom ?? cameraFrame.mapCameraState.zoom,
      globe: presentation.globeRenderState.globeUniform,
      renderSurfaceMode: presentation.renderSurfaceMode,
      cameraEye: cameraFrame.cameraEye,
      projectionView: cameraFrame.cameraMatrices.projectionView,
      verticalFovRadians: RenderCamera.verticalFovRadians,
      drawableHeightPx: drawHeight,
    });
  }

  update(context: FrameContext): void {
    const scene = this.state();
    this.haze = undefined;
    if (scene === undefined) return;
    const haze = HorizonRenderSubsystem.resolveHaze(scene, context.drawHeight);
    if (!haze.drawsSky && !haze.drawsGround) return;
    this.haze = haze;
    writeHorizonUniform(this.staging, haze, scene.cameraFrame.cameraMatrices.projectionView, scene.cameraFrame.cameraEye);
    this.gpu.device.queue.writeBuffer(this.uniformBuffer, 0, this.staging);
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    const haze = this.haze;
    if (layer !== "horizon" || haze === undefined) return;
    const { pipeline } = this;
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, pipeline.vertexBuffer);
    pass.setIndexBuffer(pipeline.indexBuffer, "uint16");
    if (haze.drawsGround) {
      pass.setPipeline(pipeline.ground);
      // The haze lands on the ground, never on a building or a model.
      pass.setStencilReference(0);
      pass.drawIndexed(pipeline.indexCount);
    }
    if (haze.drawsSky) {
      pass.setPipeline(pipeline.sky);
      pass.drawIndexed(pipeline.indexCount);
    }
  }
}
