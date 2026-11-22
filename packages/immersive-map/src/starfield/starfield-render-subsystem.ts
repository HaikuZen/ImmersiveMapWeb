// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { StarfieldSettings } from "../configuration/scene-settings.ts";
import { GlobeSkyVisibilityMath } from "../globe/globe-sky-visibility-math.ts";
import { GlobeSunDirection } from "../globe/globe-sun-direction.ts";
import { mat4Invert } from "../math/mat4-invert.ts";
import { type Mat4, Matrix, mat4Multiply } from "../math/matrix.ts";
import type { RenderLayer } from "../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import type { SceneFrameState } from "../render/scene-frame-state.ts";
import starfieldSource from "./shaders/starfield-stars.wgsl?raw";
import { StarfieldModel } from "./starfield-model.ts";

/** The GPU the stars draw into. */
export interface StarfieldPipelineContext {
  readonly device: GPUDevice;
  readonly colorFormat: GPUTextureFormat;
  readonly depthStencilFormat: GPUTextureFormat;
  readonly sampleCount: number;
}

/** `StarfieldParams` in starfield-stars.wgsl: two matrices, the viewport, the radius, the scale and the clock. */
const PARAMS_BYTES = 160;
const STAR_STRIDE = 32;

/**
 * The stars' pipeline, a port of the Swift `StarfieldPipeline`: additive,
 * with `one` for the alpha so coverage accumulates like the colour instead
 * of being squared by the source alpha, tested at the far plane against the
 * cleared depth without writing (the Swift `skyBackdropDepthState`).
 */
function makeStarfieldPipeline(context: StarfieldPipelineContext, layout: GPUBindGroupLayout): GPURenderPipeline {
  const { device, colorFormat, depthStencilFormat, sampleCount } = context;
  const module = device.createShaderModule({ label: "starfield", code: starfieldSource });
  const attribute = (shaderLocation: number, offset: number, format: GPUVertexFormat): GPUVertexAttribute => ({ shaderLocation, offset, format });
  return device.createRenderPipeline({
    label: "starfield",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: {
      module,
      entryPoint: "starfieldVertex",
      buffers: [
        {
          arrayStride: STAR_STRIDE,
          stepMode: "instance",
          attributes: [
            attribute(0, 0, "float32x3"),
            attribute(1, 12, "float32"),
            attribute(2, 16, "float32"),
            attribute(3, 20, "float32"),
            attribute(4, 24, "float32"),
            attribute(5, 28, "float32"),
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "starfieldFragment",
      targets: [
        {
          format: colorFormat,
          blend: {
            color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one" },
            alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: depthStencilFormat, depthWriteEnabled: false, depthCompare: "less-equal" },
    multisample: { count: sampleCount },
  });
}

/**
 * The globe-aligned starfield, a port of the Swift `StarfieldRenderer` and
 * `StarfieldRenderSubsystem`: a fixed buffer of unit-sphere positions,
 * rotated with the globe's pan, drawn with their own projection (the
 * settings' near and far) so the map's depth precision is untouched. Space
 * itself is the world pass's clear colour, not a draw. Only on the sphere,
 * and skipped where the resting planet fills the whole viewport.
 */
export class StarfieldRenderSubsystem implements RenderSubsystem {
  readonly name = "Starfield";
  readonly layers: readonly RenderLayer[] = ["starfield"];
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  /** Undefined when the model is empty (`starCount` 0): the pass is skipped and space still shows. */
  private readonly starBuffer: GPUBuffer | undefined;
  private readonly starCount: number;
  private readonly paramsBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly staging = new Float32Array(PARAMS_BYTES / 4);
  private readonly projection: Mat4 = new Float64Array(16);
  private readonly matrix: Mat4 = new Float64Array(16);
  private readonly inverse: Mat4 = new Float64Array(16);
  private projectionAspect: number | undefined;
  private drawsThisFrame = false;

  constructor(
    private readonly gpu: StarfieldPipelineContext,
    private readonly config: StarfieldSettings,
    private readonly state: () => SceneFrameState | undefined,
  ) {
    const { device } = gpu;
    this.layout = device.createBindGroupLayout({
      label: "starfield",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { minBindingSize: PARAMS_BYTES } }],
    });
    this.pipeline = makeStarfieldPipeline(gpu, this.layout);
    const stars = StarfieldModel.makeStars(config);
    this.starCount = stars.length;
    if (stars.length > 0) {
      const data = StarfieldModel.vertexData(stars);
      this.starBuffer = device.createBuffer({ label: "starfield stars", size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.starBuffer, 0, data);
    }
    this.paramsBuffer = device.createBuffer({ label: "starfield", size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = device.createBindGroup({ label: "starfield", layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }] });
  }

  /** Whether the space decor is painted at all: the starfield is the only one, and transparent space has none. */
  static isStarfieldEnabled(settings: ImmersiveMapSettings): boolean {
    return !settings.scene.space.isTransparent;
  }

  /**
   * At region zooms the planet fills the whole viewport: no sky pixel
   * exists, and the stars would be pure waste. Valid on the resting sphere
   * only: mid-morph the decor draws at full strength.
   */
  frameShowsSky(scene: SceneFrameState): boolean {
    const globe = scene.presentation.globeRenderState.globeUniform;
    if (globe.transition > 0) return true;
    if (!mat4Invert(this.inverse, scene.cameraFrame.cameraMatrices.projectionView)) return true;
    return GlobeSkyVisibilityMath.isSkyVisible(this.inverse, scene.cameraFrame.cameraEye, globe.radius);
  }

  update(context: FrameContext): void {
    this.drawsThisFrame = false;
    const scene = this.state();
    if (scene === undefined || this.starBuffer === undefined || this.starCount === 0) return;
    if (scene.presentation.renderSurfaceMode !== "spherical" || !StarfieldRenderSubsystem.isStarfieldEnabled(scene.settings) || !this.frameShowsSky(scene)) return;
    const aspect = context.drawWidth / context.drawHeight;
    if (this.projectionAspect !== aspect) {
      Matrix.perspectiveMatrix(this.projection, Math.PI / 4, aspect, this.config.near, this.config.far);
      this.projectionAspect = aspect;
    }
    mat4Multiply(this.matrix, this.projection, scene.cameraFrame.cameraMatrices.view);
    const globe = scene.presentation.globeRenderState.globeUniform;
    const rotation = GlobeSunDirection.globeRotationMatrix(globe);
    const s = this.staging;
    s.set(this.matrix, 0);
    s.set(rotation, 16);
    s[32] = context.drawWidth;
    s[33] = context.drawHeight;
    s[34] = globe.radius;
    s[35] = this.config.radiusScale;
    // The twinkle's clock, wrapped so the f32 phase keeps its precision.
    s[36] = scene.timeSeconds % 3600;
    this.gpu.device.queue.writeBuffer(this.paramsBuffer, 0, s);
    this.drawsThisFrame = true;
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    if (layer !== "starfield" || !this.drawsThisFrame || this.starBuffer === undefined) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.starBuffer);
    pass.draw(6, this.starCount);
  }
}
