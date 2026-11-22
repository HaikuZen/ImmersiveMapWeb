// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pipelines of the raster tiles, a port of the Swift
 * `RasterTilePipeline` (tile-raster-bake.wgsl, tile-raster.wgsl,
 * raster-mip.wgsl): the bake, which draws a tile's fills into its window
 * of the frame's atlas when its texture must be drawn again, the mip
 * chain's downsample, and the draw of the texture on the plane, on the
 * resting sphere and through the unroll (tile-raster-sphere.wgsl), and the
 * draw on the ground relief (`flatRelief`, tile-raster.wgsl with
 * `kTileRasterRelief`), whose layout carries the relief's group 3.
 */

import bake from "../shaders/tile-raster-bake.wgsl?raw";
import mip from "../shaders/raster-mip.wgsl?raw";
import draw from "../shaders/tile-raster.wgsl?raw";
import sphereDraw from "../shaders/tile-raster-sphere.wgsl?raw";
import relief from "../relief/shaders/ground-relief.wgsl?raw";
import groundFog from "../../ground-fog/shaders/ground-fog.wgsl?raw";
import groundShadowReceiver from "../../shadows/shaders/ground-shadow-receiver.wgsl?raw";
import shadowLibrary from "../../shadows/shaders/shadow.wgsl?raw";
import { globeModuleSource } from "../../globe/globe-shader-source.ts";
import shading from "../shaders/tile-shading.wgsl?raw";
import { gridVertexLayout } from "../pipelines/placement-pipeline.ts";
import { flatTileDepthStencil, tileBlend, TILE_VERTEX_STRIDE, type TilePipelineContext } from "../pipelines/tile-pipeline.ts";
import type { RasterizationSettings } from "../../configuration/tile-settings.ts";
import { stageEntry } from "../../render/core/stage-constants.ts";

/**
 * The texture format: the colour the engine renders in, unconverted. The
 * world pass draws into an 8-bit unorm drawable and blends there, so the
 * texture keeps the same encoded values, and a raster tile shows the
 * colours its geometry would.
 */
export const RASTER_TILE_TEXTURE_FORMAT: GPUTextureFormat = "rgba8unorm";

/**
 * The samples per texel the bake draws with, resolved into the texture's
 * first level: the edges of the fills are smooth before the mip chain is
 * made from them.
 */
export const RASTER_TILE_BAKE_SAMPLE_COUNT = 4;

/** The bake reads a tile vertex's position and style index alone. */
const bakeVertexLayout: GPUVertexBufferLayout = {
  arrayStride: TILE_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x2" },
    { shaderLocation: 1, offset: 8, format: "uint8" },
  ],
};

export interface RasterTileLayouts {
  /** The tile pipelines' frame group (camera, overview fade). */
  readonly frameLayout: GPUBindGroupLayout;
  /** The per-draw storage array (decision B6). */
  readonly drawLayout: GPUBindGroupLayout;
  /** A ground layer's style tables. */
  readonly stylesLayout: GPUBindGroupLayout;
  /** The ground relief's group (`FlatTilePipelines.reliefLayout`). */
  readonly reliefLayout: GPUBindGroupLayout;
}

export class RasterTilePipeline {
  /** A raster tile's texture and its sampler (the draw's group 2). */
  readonly textureLayout: GPUBindGroupLayout;
  /** One mip level read by the downsample (its group 0). */
  readonly mipLayout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;
  /** The downsample's bilinear sampler. */
  readonly mipSampler: GPUSampler;
  /** The per-draw storage array's layout, shared with the vector ground. */
  readonly drawLayout: GPUBindGroupLayout;

  private constructor(
    readonly bake: GPURenderPipeline,
    readonly mip: GPURenderPipeline,
    readonly flat: GPURenderPipeline,
    readonly flatRelief: GPURenderPipeline,
    private readonly spherePipelines: readonly [GPURenderPipeline, GPURenderPipeline],
    layouts: { textureLayout: GPUBindGroupLayout; mipLayout: GPUBindGroupLayout; drawLayout: GPUBindGroupLayout; sampler: GPUSampler; mipSampler: GPUSampler },
  ) {
    this.drawLayout = layouts.drawLayout;
    this.textureLayout = layouts.textureLayout;
    this.mipLayout = layouts.mipLayout;
    this.sampler = layouts.sampler;
    this.mipSampler = layouts.mipSampler;
  }

  /** The draw on the sphere, through the unroll when `morph`. */
  sphere(morph: boolean): GPURenderPipeline {
    return this.spherePipelines[morph ? 1 : 0];
  }

  /**
   * Every pipeline compiled up front, so no frame stalls on a compile.
   * `clipDistances`: the device has the feature (the unroll's cut).
   */
  static async create(context: TilePipelineContext, layouts: RasterTileLayouts, settings: RasterizationSettings, clipDistances: boolean): Promise<RasterTilePipeline> {
    const { device, colorFormat, depthStencilFormat, sampleCount } = context;
    const fragment = GPUShaderStage.FRAGMENT;
    const textureLayout = device.createBindGroupLayout({
      label: "raster tile texture",
      entries: [
        { binding: 0, visibility: fragment, texture: { sampleType: "float" } },
        { binding: 1, visibility: fragment, sampler: { type: "filtering" } },
      ],
    });
    const mipLayout = device.createBindGroupLayout({
      label: "raster tile mip",
      entries: [
        { binding: 0, visibility: fragment, texture: { sampleType: "float" } },
        { binding: 1, visibility: fragment, sampler: { type: "filtering" } },
      ],
    });
    // The edge texels repeat past the tile: a tile's mips never reach into
    // the texture's opposite side.
    const sampler = device.createSampler({
      label: "raster tile",
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: Math.min(Math.max(Math.round(settings.maximumAnisotropy), 1), 16),
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const mipSampler = device.createSampler({ label: "raster tile mip", minFilter: "linear", magFilter: "linear" });

    const bakeModule = device.createShaderModule({ label: "raster tile bake", code: shading + "\n" + bake });
    const mipModule = device.createShaderModule({ label: "raster tile mip", code: mip });
    const drawCode = [groundFog, shadowLibrary, groundShadowReceiver, relief, draw].join("\n");
    const sphereCode = globeModuleSource(clipDistances, [], sphereDraw);
    const drawModule = device.createShaderModule({ label: "raster tile", code: drawCode });
    const sphereModule = device.createShaderModule({ label: "raster tile sphere", code: sphereCode });
    const constants = { kTileRasterMipLevelBias: settings.mipLevelBias };
    const drawLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frameLayout, layouts.drawLayout, textureLayout] });
    // The plane's draw and the relief's share one module, which reads the relief's group.
    const flatLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frameLayout, layouts.drawLayout, textureLayout, layouts.reliefLayout] });
    const flat = (raised: boolean) =>
      device.createRenderPipelineAsync({
        label: `raster tile flat${raised ? " relief" : ""}`,
        layout: flatLayout,
        vertex: { module: drawModule, ...stageEntry(drawCode, "tileRasterFlatVertex", { kTileRasterRelief: raised ? 1 : 0 }), buffers: [gridVertexLayout] },
        fragment: { module: drawModule, ...stageEntry(drawCode, "tileRasterFlatFragment", { ...constants, kTileRasterRelief: raised ? 1 : 0 }), targets: [{ format: colorFormat }] },
        primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
        depthStencil: flatTileDepthStencil(depthStencilFormat, "opaqueFills"),
        multisample: { count: sampleCount },
      });
    const sphere = (morph: boolean) => {
      const sphereConstants = { kGlobeMorph: morph ? 1 : 0, kTileRasterMipLevelBias: settings.mipLevelBias };
      return device.createRenderPipelineAsync({
        label: `raster tile sphere${morph ? " morph" : ""}`,
        layout: drawLayout,
        vertex: { module: sphereModule, ...stageEntry(sphereCode, "tileRasterSphereVertex", sphereConstants), buffers: [gridVertexLayout] },
        fragment: { module: sphereModule, ...stageEntry(sphereCode, "tileRasterSphereFragment", sphereConstants), targets: [{ format: colorFormat }] },
        // The far side of the planet goes to back-face culling, as the
        // vector ground's does. The depth is the ground's first rank.
        primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
        depthStencil: flatTileDepthStencil(depthStencilFormat, "opaqueFills"),
        multisample: { count: sampleCount },
      });
    };
    const [bakePipeline, mipPipeline, flatPipeline, flatReliefPipeline, spherePure, sphereMorph] = await Promise.all([
      device.createRenderPipelineAsync({
        label: "raster tile bake",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frameLayout, layouts.stylesLayout] }),
        vertex: { module: bakeModule, entryPoint: "tileRasterBakeVertex", buffers: [bakeVertexLayout] },
        // The fills in buffer order, each over what is under it, the way the vector ground layers them.
        fragment: { module: bakeModule, entryPoint: "tileRasterBakeFragment", targets: [{ format: RASTER_TILE_TEXTURE_FORMAT, blend: tileBlend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        multisample: { count: RASTER_TILE_BAKE_SAMPLE_COUNT },
      }),
      device.createRenderPipelineAsync({
        label: "raster tile mip",
        layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
        vertex: { module: mipModule, entryPoint: "rasterMipVertex" },
        fragment: { module: mipModule, entryPoint: "rasterMipFragment", targets: [{ format: RASTER_TILE_TEXTURE_FORMAT }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      }),
      // The draw: opaque, in the world pass, through the ground's depth and
      // stencil. Every grid triangle is counter-clockwise in render space, as
      // every tile triangle is, and the plane does not mirror: back faces
      // are culled.
      flat(false),
      flat(true),
      sphere(false),
      sphere(true),
    ]);
    return new RasterTilePipeline(bakePipeline, mipPipeline, flatPipeline, flatReliefPipeline, [spherePure, sphereMorph], { textureLayout, mipLayout, drawLayout: layouts.drawLayout, sampler, mipSampler });
  }
}
