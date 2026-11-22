// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The flat tile pipelines, a port of the Swift `TilePipeline` (flat surface)
 * with the depth-stencil states of `SharedRenderResources`. In Metal the
 * depth-stencil state is set per draw, in WebGPU it is part of the pipeline,
 * so each class comes with the state it always draws under:
 *
 * - `opaqueFills`: the ground's opaque fills, unblended, the rank band
 *   written (less-equal) under the tile-priority test (the priority bits alone).
 * - `fills`: the translucent fills, blended, tested only.
 * - `lines`: the ground's ribbons, the sphere-era roads and the bridge
 *   overlay, blended, tested only, with the line fields.
 * - `roadOpaque` / `roadBlended`: the road ribbons, the rank written under a
 *   strict test, unblended or blended.
 * - `roadEdgeLines`: the roads' one-pixel edge lines, line primitives,
 *   blended at a share of the alpha, tested only.
 *
 * Every non-owning pass reads the surface mask bit too, so nothing lying on
 * the ground paints over a building or a model.
 *
 * Each class has its relief variant (tile.wgsl, `kTileGroundRelief`): the
 * vertex raised by the terrain bound at group 3 (ground-relief.wgsl), the
 * fills' slopes shaded and their valleys darkened, the shadow read from the
 * shadow map at the raised point. Over a relief the ground writes its real
 * depth, and what lies on it (the lines, the roads, the bridges) draws with
 * a slope-scaled depth bias toward the eye, which keeps it over the ground
 * where its triangles sample the terrain apart from the ground's. A line
 * primitive takes no depth bias in WebGPU: the roads' edge lines are pulled
 * toward the eye in the vertex stage instead (`kTileReliefLineDepthPull`).
 * Every class shares one layout, the relief's group included, so a draw on
 * the plane binds the relief's empty group (`GroundReliefGpu.bindEmpty`).
 */

import groundFog from "../../ground-fog/shaders/ground-fog.wgsl?raw";
import groundShadowReceiver from "../../shadows/shaders/ground-shadow-receiver.wgsl?raw";
import shadowLibrary from "../../shadows/shaders/shadow.wgsl?raw";
import shading from "../shaders/tile-shading.wgsl?raw";
import tile from "../shaders/tile.wgsl?raw";
import relief_ from "../relief/shaders/ground-relief.wgsl?raw";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import { groundReliefBindGroupLayout } from "../relief/frame/ground-relief-gpu.ts";
import { stageEntry } from "../../render/core/stage-constants.ts";

export type FlatTileClass = "opaqueFills" | "fills" | "lines" | "roadOpaque" | "roadBlended" | "roadEdgeLines";

/** The tile vertex (the Swift `TileVertexIn`), 16 bytes. */
export const TILE_VERTEX_STRIDE = 16;

export const tileVertexLayout: GPUVertexBufferLayout = {
  arrayStride: TILE_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x2" },
    { shaderLocation: 1, offset: 8, format: "uint8" },
    { shaderLocation: 2, offset: 9, format: "sint8" },
    { shaderLocation: 3, offset: 10, format: "sint16" },
    { shaderLocation: 4, offset: 12, format: "snorm8x2" },
  ],
};

/** Coverage accumulates on a transparent destination, over an opaque one the result is unchanged. */
export const tileBlend: GPUBlendState = {
  color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

function priorityStencil(opaque: boolean): GPUStencilFaceState {
  return { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
}

/**
 * The depth-stencil state of a class. The raster tiles draw under the
 * opaque fills' (the Swift `groundOwnerState`).
 */
export function flatTileDepthStencil(format: GPUTextureFormat, tileClass: FlatTileClass, relief = false): GPUDepthStencilState {
  const opaque = tileClass === "opaqueFills";
  // Over a relief what lies on the ground keeps over it by a bias that
  // scales with the slope (the Swift `setDepthBias(-1, slopeScale: -1)`).
  const biased = relief && !opaque && tileClass !== "roadEdgeLines";
  const readMask = opaque ? TileSourceStencilPriority.priorityMask : TileSourceStencilPriority.priorityMask | TileSourceStencilPriority.surfaceMaskBit;
  const writesRank = tileClass === "opaqueFills" || tileClass === "roadOpaque" || tileClass === "roadBlended";
  return {
    format,
    depthWriteEnabled: writesRank,
    depthCompare: opaque ? "less-equal" : "less",
    stencilFront: priorityStencil(opaque),
    stencilBack: priorityStencil(opaque),
    stencilReadMask: readMask,
    stencilWriteMask: 0,
    ...(biased ? { depthBias: -1, depthBiasSlopeScale: -1 } : {}),
  };
}

/** How far the relief's line primitives are pulled toward the eye in place of a depth bias, a share of the clip w (`kTileReliefLineDepthPull`). */
export const TILE_RELIEF_LINE_DEPTH_PULL = 2e-6;

export interface TilePipelineContext {
  device: GPUDevice;
  colorFormat: GPUTextureFormat;
  depthStencilFormat: GPUTextureFormat;
  sampleCount: number;
}

export class FlatTilePipelines {
  readonly frameLayout: GPUBindGroupLayout;
  readonly drawLayout: GPUBindGroupLayout;
  readonly stylesLayout: GPUBindGroupLayout;
  /** The ground relief's group (group 3), `GroundReliefGpu` binds it. */
  readonly reliefLayout: GPUBindGroupLayout;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly pipelineLayout: GPUPipelineLayout;
  private module: GPUShaderModule | undefined;

  constructor(private readonly context: TilePipelineContext) {
    const { device } = context;
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.frameLayout = device.createBindGroupLayout({
      label: "tile frame",
      entries: [
        { binding: 0, visibility, buffer: {} },
        { binding: 1, visibility, buffer: {} },
        // The ground fog (src/ground-fog), mixed in by every ground fragment.
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        // The globe (globe/globe-frame-uniform.ts): what every draw on the
        // sphere and through the unroll projects and lights by.
        { binding: 3, visibility, buffer: {} },
        // The ground's shadows (shadows/shaders/ground-shadow-receiver.wgsl):
        // the frame's shadow uniform, the ground shadow mask and its sampler.
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        // The shadow map's windows, which the relief samples at its raised points.
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      ],
    });
    this.drawLayout = device.createBindGroupLayout({
      label: "tile draw",
      entries: [{ binding: 0, visibility, buffer: { type: "read-only-storage", minBindingSize: 80 } }],
    });
    this.stylesLayout = device.createBindGroupLayout({
      label: "tile styles",
      entries: [0, 1, 2].map((binding) => ({ binding, visibility, buffer: { type: "read-only-storage" as const } })),
    });
    this.reliefLayout = groundReliefBindGroupLayout(device);
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.drawLayout, this.stylesLayout, this.reliefLayout] });
  }

  /** A class's pipeline, its relief variant with `relief`. */
  pipeline(tileClass: FlatTileClass, relief = false): GPURenderPipeline {
    const key = `${tileClass}${relief ? " relief" : ""}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.context.device.createRenderPipeline(this.descriptor(tileClass, relief));
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Builds every class up front, so no frame stalls on a compile. `relief` builds the relief variants too. */
  async prewarm(relief = false): Promise<void> {
    const classes: FlatTileClass[] = ["opaqueFills", "fills", "lines", "roadOpaque", "roadBlended", "roadEdgeLines"];
    const variants = relief ? [false, true] : [false];
    await Promise.all(
      classes.flatMap((c) =>
        variants.map(async (r) => {
          const key = `${c}${r ? " relief" : ""}`;
          if (!this.pipelines.has(key)) this.pipelines.set(key, await this.context.device.createRenderPipelineAsync(this.descriptor(c, r)));
        }),
      ),
    );
  }

  private descriptor(tileClass: FlatTileClass, relief: boolean): GPURenderPipelineDescriptor {
    const { device, colorFormat, depthStencilFormat, sampleCount } = this.context;
    const code = [shading, groundFog, shadowLibrary, groundShadowReceiver, relief_, tile].join("\n");
    this.module ??= device.createShaderModule({ label: "tile", code });
    const module = this.module;
    const road = tileClass === "roadOpaque" || tileClass === "roadBlended" || tileClass === "roadEdgeLines";
    const constants: Record<string, number> = {
      kTileLineFields: tileClass === "opaqueFills" || tileClass === "fills" ? 0 : 1,
      kTileRoadRibbons: road ? 1 : 0,
      kTileRoadBlended: tileClass === "roadBlended" || tileClass === "roadEdgeLines" ? 1 : 0,
      kTileGroundRelief: relief ? 1 : 0,
      kTileReliefLineDepthPull: relief && tileClass === "roadEdgeLines" ? TILE_RELIEF_LINE_DEPTH_PULL : 0,
    };
    const blended = tileClass !== "opaqueFills" && tileClass !== "roadOpaque";
    return {
      label: `tile ${tileClass}${relief ? " relief" : ""}`,
      layout: this.pipelineLayout,
      vertex: { module, ...stageEntry(code, "tileVertex", constants), buffers: [tileVertexLayout] },
      fragment: {
        module,
        ...stageEntry(code, road ? "tileRoadFragment" : "tileFragment", constants),
        targets: [{ format: colorFormat, ...(blended ? { blend: tileBlend } : {}) }],
      },
      primitive: tileClass === "roadEdgeLines" ? { topology: "line-list" } : { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
      depthStencil: flatTileDepthStencil(depthStencilFormat, tileClass === "roadEdgeLines" ? "roadEdgeLines" : tileClass, relief),
      multisample: { count: sampleCount },
    };
  }
}
