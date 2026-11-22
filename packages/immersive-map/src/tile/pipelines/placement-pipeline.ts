// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The placement prepass pipelines (the Swift `PlacementStencilPipeline`):
 * the depth always passes and is never written, the stencil always passes
 * and its priority bits are replaced by the source's reference (the Swift
 * `makePlacementStencilWriteDescriptor`). Colour writes are off. On the
 * plane a placement's square is two triangles. On the sphere it is the
 * raster tile's grid through the raster tile's vertex stage
 * (tile-raster-sphere.wgsl), resting or in the morph, so the marks lie where
 * the ground lies. On the relief the square is the grid raised by its
 * source's terrain, in two passes (placement-relief.wgsl): the ground's
 * depth, then the marks tested against it, and the depth reset.
 */

import { globeModuleSource } from "../../globe/globe-shader-source.ts";
import placement from "../shaders/placement.wgsl?raw";
import placementRelief from "../shaders/placement-relief.wgsl?raw";
import relief from "../relief/shaders/ground-relief.wgsl?raw";
import rasterSphere from "../shaders/tile-raster-sphere.wgsl?raw";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";

/** A raster grid's vertex: its tile-local position. */
export const gridVertexLayout: GPUVertexBufferLayout = {
  arrayStride: 8,
  attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
};

export interface PlacementPipelineOptions {
  colorFormat: GPUTextureFormat;
  depthStencilFormat: GPUTextureFormat;
  sampleCount: number;
  frameLayout: GPUBindGroupLayout;
  drawLayout: GPUBindGroupLayout;
  /** The device has `clip-distances` (the unroll's cut). */
  clipDistances: boolean;
  /** The ground relief's group (`FlatTilePipelines.reliefLayout`). */
  reliefLayout: GPUBindGroupLayout;
}

export class PlacementPipeline {
  /** The plane's squares. */
  readonly pipeline: GPURenderPipeline;
  /**
   * The relief's passes (placement-relief.wgsl), each on the raised grid and
   * on the flat grid for a square whose terrain is not in: the ground's
   * depth, written behind the surface by a bias, then the marks tested
   * against it, then the depth reset to the far plane.
   */
  readonly reliefGroundDepth: GPURenderPipeline;
  readonly flatGroundDepth: GPURenderPipeline;
  readonly reliefMarks: GPURenderPipeline;
  readonly flatMarksTested: GPURenderPipeline;
  readonly depthReset: GPURenderPipeline;
  /** The empty group 2 of the relief's layout, which reads the relief at group 3. */
  readonly emptyGroup: GPUBindGroup;
  /** The sphere's grids: resting (index 0) and through the unroll (index 1). */
  private readonly spherePipelines: readonly [GPURenderPipeline, GPURenderPipeline];
  readonly drawLayout: GPUBindGroupLayout;

  constructor(device: GPUDevice, options: PlacementPipelineOptions) {
    this.drawLayout = options.drawLayout;
    const mark: GPUStencilFaceState = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
    const depthStencil: GPUDepthStencilState = {
      format: options.depthStencilFormat,
      depthWriteEnabled: false,
      depthCompare: "always",
      stencilFront: mark,
      stencilBack: mark,
      stencilReadMask: 0,
      stencilWriteMask: TileSourceStencilPriority.priorityMask,
    };
    const layout = device.createPipelineLayout({ bindGroupLayouts: [options.frameLayout, options.drawLayout] });
    const targets: GPUColorTargetState[] = [{ format: options.colorFormat, writeMask: 0 }];
    // Every triangle is counter-clockwise in render space and neither
    // surface mirrors: back faces are culled, which on the sphere removes
    // its far side.
    const primitive: GPUPrimitiveState = { topology: "triangle-list", frontFace: "ccw", cullMode: "back" };
    const multisample: GPUMultisampleState = { count: options.sampleCount };
    const flatModule = device.createShaderModule({ label: "placement", code: placement });
    this.pipeline = device.createRenderPipeline({
      label: "placement stencil",
      layout,
      vertex: { module: flatModule, entryPoint: "placementVertex" },
      fragment: { module: flatModule, entryPoint: "placementFragment", targets },
      primitive,
      depthStencil,
      multisample,
    });
    const sphereModule = device.createShaderModule({ label: "placement sphere", code: globeModuleSource(options.clipDistances, [], rasterSphere) });
    const sphere = (morph: boolean): GPURenderPipeline => {
      const constants = { kGlobeMorph: morph ? 1 : 0 };
      return device.createRenderPipeline({
        label: `placement stencil sphere${morph ? " morph" : ""}`,
        layout,
        vertex: { module: sphereModule, entryPoint: "tileRasterSphereVertex", constants, buffers: [gridVertexLayout] },
        fragment: { module: sphereModule, entryPoint: "placementSphereFragment", constants, targets },
        primitive,
        depthStencil,
        multisample,
      });
    };
    this.spherePipelines = [sphere(false), sphere(true)];

    const emptyLayout = device.createBindGroupLayout({ label: "placement empty", entries: [] });
    this.emptyGroup = device.createBindGroup({ label: "placement empty", layout: emptyLayout, entries: [] });
    const reliefLayout = device.createPipelineLayout({ bindGroupLayouts: [options.frameLayout, options.drawLayout, emptyLayout, options.reliefLayout] });
    const reliefModule = device.createShaderModule({ label: "placement relief", code: [relief, placementRelief].join("\n") });
    // The ground's depth: written behind the surface by one step and one
    // step of its slope, so its own mark, the same grid drawn again,
    // passes less-equal against it through the rasterizer's rounding.
    const groundDepth: GPUDepthStencilState = {
      format: options.depthStencilFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
      stencilReadMask: 0,
      stencilWriteMask: 0,
      depthBias: 1,
      depthBiasSlopeScale: 1,
    };
    // The marks: where a placement's ground is the one in front, the depth left as it is.
    const testedMarks: GPUDepthStencilState = { ...depthStencil, depthCompare: "less-equal" };
    const reliefPipeline = (label: string, entryPoint: string, state: GPUDepthStencilState): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: reliefLayout,
        vertex: { module: reliefModule, entryPoint, buffers: [gridVertexLayout] },
        fragment: { module: reliefModule, entryPoint: "placementReliefFragment", targets },
        primitive,
        depthStencil: state,
        multisample,
      });
    this.reliefGroundDepth = reliefPipeline("placement relief depth", "placementReliefVertex", groundDepth);
    this.flatGroundDepth = reliefPipeline("placement flat depth", "placementGridVertex", groundDepth);
    this.reliefMarks = reliefPipeline("placement relief marks", "placementReliefVertex", testedMarks);
    this.flatMarksTested = reliefPipeline("placement flat marks", "placementGridVertex", testedMarks);
    this.depthReset = device.createRenderPipeline({
      label: "placement depth reset",
      layout: reliefLayout,
      vertex: { module: reliefModule, entryPoint: "placementDepthResetVertex" },
      fragment: { module: reliefModule, entryPoint: "placementReliefFragment", targets },
      primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
      depthStencil: { format: options.depthStencilFormat, depthWriteEnabled: true, depthCompare: "always", stencilReadMask: 0, stencilWriteMask: 0 },
      multisample,
    });
  }

  /** The sphere's marks, through the unroll when `morph`. */
  sphere(morph: boolean): GPURenderPipeline {
    return this.spherePipelines[morph ? 1 : 0];
  }
}
