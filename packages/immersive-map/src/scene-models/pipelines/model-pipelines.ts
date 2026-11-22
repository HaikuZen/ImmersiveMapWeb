// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pipelines the 3D models draw with, the Swift `ModelTilePipeline` and
 * `SceneModelPipeline` with the depth-stencil states of
 * `SharedRenderResources` they draw under (in WebGPU a pipeline carries its
 * depth-stencil state):
 *
 * - the model tiles (scene-models/shaders/model-tile.wgsl): the opaque
 *   world-pass pipeline, its variant that drops the fragments below the
 *   ground for a tile coming up out of it, and the shadow casters, over the
 *   vertex a model tile carries, in the tile's space;
 * - the app's scene models (scene-model.wgsl): the opaque pipeline, the two
 *   model draws of the ground cut (inside the ground hole whole, outside it
 *   with the fragments below the surface dropped), the two footprint draws
 *   that raise and lower the ground hole bit, and the casters.
 *
 * Every world-pass draw tests and writes the scene depth (less-equal) and
 * raises the surface mask bit where it lands, as the buildings do, so the
 * horizon's haze and what lies on the ground pass the models by. The frame
 * group is the buildings' (`StandingPipelines.standingFrameLayout`): the
 * camera, their fog and the shadows.
 */

import { clipDistanceVariant } from "../../globe/clip-distance-variant.ts";
import clipDistancesLibrary from "../../globe/shaders/clip-distances.wgsl?raw";
import groundFog from "../../ground-fog/shaders/ground-fog.wgsl?raw";
import shadowLibrary from "../../shadows/shaders/shadow.wgsl?raw";
import { ShadowCascadeAtlas } from "../../shadows/shadow-cascade-atlas.ts";
import standingFrame from "../../tile/shaders/standing-frame.wgsl?raw";
import { TileSourceStencilPriority } from "../../tile/drawers/depth-rank.ts";
import type { StandingPipelines } from "../../tile/pipelines/standing-pipelines.ts";
import type { TilePipelineContext } from "../../tile/pipelines/tile-pipeline.ts";
import modelTileSource from "../shaders/model-tile.wgsl?raw";
import sceneModelSource from "../shaders/scene-model.wgsl?raw";
import { stageEntry } from "../../render/core/stage-constants.ts";

/** The 16-byte vertex of a model tile (`ModelTileContents.vertexStride`). */
export const MODEL_TILE_VERTEX_STRIDE = 16;

/** The scene models' canonical interleaved vertex: position @0, normal @12, uv @24 (Swift `SceneModelAssetLoader`). */
export const SceneModelVertexLayout = { stride: 32, normalOffset: 12, uvOffset: 24 } as const;

/** One scene model draw's record (scene-model.wgsl `SceneModelDraw`): a matrix and four vec4f. */
export const SCENE_MODEL_DRAW_BYTES = 128;

/**
 * The model tile vertex through the formats WebGPU has (no three-component
 * 16-bit format, and an attribute's offset a multiple of four bytes for a
 * format of four or more): the position as the first three of four shorts,
 * the texture coordinate as the middle two of the four from byte 4, the
 * normal as two bytes and one, the layer.
 */
const modelTileVertexLayout: GPUVertexBufferLayout = {
  arrayStride: MODEL_TILE_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "unorm16x4" },
    { shaderLocation: 1, offset: 4, format: "unorm16x4" },
    { shaderLocation: 2, offset: 10, format: "snorm8x2" },
    { shaderLocation: 3, offset: 12, format: "snorm8" },
    { shaderLocation: 4, offset: 13, format: "uint8" },
  ],
};

const modelTileCasterVertexLayout: GPUVertexBufferLayout = {
  arrayStride: MODEL_TILE_VERTEX_STRIDE,
  attributes: [{ shaderLocation: 0, offset: 0, format: "unorm16x4" }],
};

const sceneModelVertexLayout: GPUVertexBufferLayout = {
  arrayStride: SceneModelVertexLayout.stride,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: SceneModelVertexLayout.normalOffset, format: "float32x3" },
    { shaderLocation: 2, offset: SceneModelVertexLayout.uvOffset, format: "float32x2" },
  ],
};

const sceneModelPositionLayout: GPUVertexBufferLayout = {
  arrayStride: SceneModelVertexLayout.stride,
  attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
};

const P = TileSourceStencilPriority;

/** The scene depth with the surface mask bit raised where the model lands (Swift `sceneModelSurfaceMaskState`). */
function surfaceMask(format: GPUTextureFormat): GPUDepthStencilState {
  const face: GPUStencilFaceState = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
  return { format, depthWriteEnabled: true, depthCompare: "less-equal", stencilFront: face, stencilBack: face, stencilReadMask: P.priorityMask, stencilWriteMask: P.surfaceMaskBit };
}

/**
 * The ground cut's model draws: the scene depth, the surface mask bit
 * raised where the model lands, and the ground hole bit tested alone, equal
 * to the reference's (raised for the draw inside the hole, clear outside).
 */
function holeTest(format: GPUTextureFormat): GPUDepthStencilState {
  const face: GPUStencilFaceState = { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
  return { format, depthWriteEnabled: true, depthCompare: "less-equal", stencilFront: face, stencilBack: face, stencilReadMask: P.groundHoleBit, stencilWriteMask: P.surfaceMaskBit };
}

/** The ground hole's footprint draws: depth neither tested nor written, the hole bit raised on every pixel of the outline, or lowered again. */
function holeFootprint(format: GPUTextureFormat, raises: boolean): GPUDepthStencilState {
  const face: GPUStencilFaceState = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: raises ? "replace" : "zero" };
  return { format, depthWriteEnabled: false, depthCompare: "always", stencilFront: face, stencilBack: face, stencilReadMask: 0, stencilWriteMask: P.groundHoleBit };
}

const casterDepth: GPUDepthStencilState = { format: ShadowCascadeAtlas.depthFormat, depthWriteEnabled: true, depthCompare: "less-equal" };

type Built = {
  modelTile: GPURenderPipeline;
  modelTileClipped: GPURenderPipeline;
  modelTileCaster: GPURenderPipeline;
  sceneModel: GPURenderPipeline;
  sceneModelHoleInside: GPURenderPipeline;
  sceneModelHoleOutside: GPURenderPipeline;
  sceneModelFootprintRaise: GPURenderPipeline;
  sceneModelFootprintLower: GPURenderPipeline;
  sceneModelCaster: GPURenderPipeline;
};

export class ModelPipelines {
  /** A model tile's texture array and its sampler (group 2). */
  readonly modelTileTextureLayout: GPUBindGroupLayout;
  /** A scene model submesh's base colour texture and its sampler (group 2). */
  readonly sceneModelTextureLayout: GPUBindGroupLayout;
  /** The scene models' own per-draw records (group 1): their record is larger than the shared one. */
  readonly sceneModelDrawLayout: GPUBindGroupLayout;
  /** The model tiles' sampler: no repeat (a tile's coordinates stay in the unit square), anisotropic (a facade is seen at a slant more often than head on). */
  readonly modelTileSampler: GPUSampler;
  /** The scene models' sampler: repeat, as Model I/O assets expect. */
  readonly sceneModelSampler: GPUSampler;
  private built: Built | undefined;

  constructor(
    private readonly context: TilePipelineContext,
    private readonly standing: StandingPipelines,
    /** The device has `clip-distances`: the below-ground cut is a clip distance and the clipped draws keep early depth. */
    private readonly clipDistances: boolean,
  ) {
    const { device } = context;
    const fragment = GPUShaderStage.FRAGMENT;
    this.modelTileTextureLayout = device.createBindGroupLayout({
      label: "model tile textures",
      entries: [
        { binding: 0, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 1, visibility: fragment, sampler: { type: "filtering" } },
      ],
    });
    this.sceneModelTextureLayout = device.createBindGroupLayout({
      label: "scene model texture",
      entries: [
        { binding: 0, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 1, visibility: fragment, sampler: { type: "filtering" } },
      ],
    });
    this.sceneModelDrawLayout = device.createBindGroupLayout({
      label: "scene model draws",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage", minBindingSize: SCENE_MODEL_DRAW_BYTES } }],
    });
    this.modelTileSampler = device.createSampler({
      label: "model tile textures",
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      maxAnisotropy: 4,
    });
    this.sceneModelSampler = device.createSampler({ label: "scene model textures", minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" });
  }

  /** The shared per-draw records' layout the model tiles read (decision B6). */
  get standingDrawLayout(): GPUBindGroupLayout {
    return this.standing.drawLayout;
  }

  /** The casters' group 0: they read nothing of the frame. */
  get emptyGroup(): GPUBindGroup {
    return this.standing.emptyGroup;
  }

  get pipelines(): Built {
    if (!this.built) {
      const d = this.descriptors();
      const { device } = this.context;
      const made = {} as Record<keyof Built, GPURenderPipeline>;
      for (const key of Object.keys(d) as (keyof Built)[]) made[key] = device.createRenderPipeline(d[key]);
      this.built = made;
    }
    return this.built;
  }

  /** Builds every pipeline up front, so no frame stalls on a compile. */
  async prewarm(): Promise<void> {
    if (this.built) return;
    const d = this.descriptors();
    const { device } = this.context;
    const keys = Object.keys(d) as (keyof Built)[];
    const pipelines = await Promise.all(keys.map((key) => device.createRenderPipelineAsync(d[key])));
    const made = {} as Record<keyof Built, GPURenderPipeline>;
    keys.forEach((key, i) => (made[key] = pipelines[i]!));
    this.built ??= made;
  }

  private descriptors(): Record<keyof Built, GPURenderPipelineDescriptor> {
    const { device, colorFormat, depthStencilFormat, sampleCount } = this.context;
    const prefix = [clipDistancesLibrary, shadowLibrary, groundFog, standingFrame].join("\n");
    const variant = (source: string) => clipDistanceVariant(prefix + "\n" + source, this.clipDistances);
    const tileCode = variant(modelTileSource);
    const sceneCode = variant(sceneModelSource);
    const tileModule = device.createShaderModule({ label: "model tile", code: tileCode });
    const sceneModule = device.createShaderModule({ label: "scene model", code: sceneCode });
    const s = this.standing;
    const tileLayout = device.createPipelineLayout({ bindGroupLayouts: [s.standingFrameLayout, s.drawLayout, this.modelTileTextureLayout] });
    const tileCasterLayout = device.createPipelineLayout({ bindGroupLayouts: [s.emptyLayout, s.drawLayout] });
    const sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [s.standingFrameLayout, this.sceneModelDrawLayout, this.sceneModelTextureLayout] });
    const sceneFootprintLayout = device.createPipelineLayout({ bindGroupLayouts: [s.standingFrameLayout, this.sceneModelDrawLayout] });
    const sceneCasterLayout = device.createPipelineLayout({ bindGroupLayouts: [s.emptyLayout, this.sceneModelDrawLayout] });
    const multisample = { count: sampleCount };
    // The models are wound counter-clockwise seen from outside.
    const opaque: GPUPrimitiveState = { topology: "triangle-list", frontFace: "ccw", cullMode: "back" };
    const both: GPUPrimitiveState = { topology: "triangle-list", cullMode: "none" };
    const modelTile = (clips: boolean): GPURenderPipelineDescriptor => ({
      label: `model tile${clips ? " clipped" : ""}`,
      layout: tileLayout,
      vertex: { module: tileModule, ...stageEntry(tileCode, "modelTileVertex", { kModelTileClipsBelowGround: clips ? 1 : 0 }), buffers: [modelTileVertexLayout] },
      fragment: { module: tileModule, ...stageEntry(tileCode, "modelTileFragment", { kModelTileClipsBelowGround: clips ? 1 : 0 }), targets: [{ format: colorFormat }] },
      primitive: opaque,
      depthStencil: surfaceMask(depthStencilFormat),
      multisample,
    });
    const sceneModel = (label: string, clips: boolean, depthStencil: GPUDepthStencilState): GPURenderPipelineDescriptor => ({
      label,
      layout: sceneLayout,
      vertex: { module: sceneModule, ...stageEntry(sceneCode, "sceneModelVertex", { kSceneModelClipsBelowGround: clips ? 1 : 0 }), buffers: [sceneModelVertexLayout] },
      fragment: { module: sceneModule, ...stageEntry(sceneCode, "sceneModelFragment", { kSceneModelClipsBelowGround: clips ? 1 : 0 }), targets: [{ format: colorFormat }] },
      primitive: opaque,
      depthStencil,
      multisample,
    });
    const footprint = (raises: boolean): GPURenderPipelineDescriptor => ({
      label: `scene model footprint ${raises ? "raise" : "lower"}`,
      layout: sceneFootprintLayout,
      vertex: { module: sceneModule, entryPoint: "sceneModelGroundFootprintVertex", buffers: [sceneModelPositionLayout] },
      fragment: { module: sceneModule, entryPoint: "sceneModelFootprintFragment", targets: [{ format: colorFormat, writeMask: 0 }] },
      primitive: both,
      depthStencil: holeFootprint(depthStencilFormat, raises),
      multisample,
    });
    return {
      modelTile: modelTile(false),
      modelTileClipped: modelTile(true),
      // Depth only, both faces, like the scene models' casters.
      modelTileCaster: {
        label: "model tile caster",
        layout: tileCasterLayout,
        vertex: { module: tileModule, entryPoint: "modelTileShadowVertex", buffers: [modelTileCasterVertexLayout] },
        primitive: both,
        depthStencil: casterDepth,
      },
      sceneModel: sceneModel("scene model", false, surfaceMask(depthStencilFormat)),
      sceneModelHoleInside: sceneModel("scene model in its ground hole", false, holeTest(depthStencilFormat)),
      sceneModelHoleOutside: sceneModel("scene model outside its ground hole", true, holeTest(depthStencilFormat)),
      sceneModelFootprintRaise: footprint(true),
      sceneModelFootprintLower: footprint(false),
      sceneModelCaster: {
        label: "scene model caster",
        layout: sceneCasterLayout,
        vertex: { module: sceneModule, entryPoint: "sceneModelShadowVertex", buffers: [sceneModelPositionLayout] },
        primitive: both,
        depthStencil: casterDepth,
      },
    };
  }
}
