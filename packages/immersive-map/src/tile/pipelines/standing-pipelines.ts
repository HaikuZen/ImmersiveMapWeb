// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pipelines of what stands on the flat map: the Swift
 * `ExtrudedTilePipeline` (the buildings into the world pass and depth-only
 * into the shadow map) and `TreePipeline` (the trees and their shadow
 * discs), with the depth-stencil states of `SharedRenderResources` they
 * draw under:
 *
 * - the buildings and the trees: the scene depth (less-equal, written), and
 *   the surface mask bit raised where they land (`extrudedStencilTestState`),
 *   so nothing lying on the ground paints over them;
 * - the casters: the scene depth into the shadow map's depth16unorm slice;
 * - the discs: the ground's depth test (less, not written), so a disc stays
 *   off a building standing nearer than its ground, multiplied into the
 *   colour.
 *
 * Their frame group (`standingFrameLayout`, tile/shaders/standing-frame.wgsl)
 * holds the camera, the fogs, the shadows and the trees' frame. The draws
 * read the shared per-draw records (`drawLayout`, decision B6), the trees'
 * tile a dynamic uniform offset each (their instance index is the tree's).
 */

import groundFog from "../../ground-fog/shaders/ground-fog.wgsl?raw";
import shadowLibrary from "../../shadows/shaders/shadow.wgsl?raw";
import { ShadowCascadeAtlas } from "../../shadows/shadow-cascade-atlas.ts";
import standingFrame from "../shaders/standing-frame.wgsl?raw";
import extruded from "../shaders/tile-extruded.wgsl?raw";
import trees from "../shaders/trees.wgsl?raw";
import { TileSourceStencilPriority } from "../drawers/depth-rank.ts";
import { TreeModelContents } from "../trees/tree-model.ts";
import type { TilePipelineContext } from "./tile-pipeline.ts";

/** The 12-byte extruded vertex (the Swift `ExtrudedVertexIn`). */
export const EXTRUDED_VERTEX_STRIDE = 12;
/** The 16-byte tree instance of the arena (the Swift `TreeInstance`). */
export const TREE_INSTANCE_STRIDE = 16;
/** One tree tile's uniform slot: the dynamic offsets' alignment. */
export const TREE_TILE_SLOT_BYTES = 256;
/** The tree tile's uniform (trees.wgsl `TreeTile`): a matrix and the height scale. */
export const TREE_TILE_BYTES = 80;

/**
 * The trees' frame uniform (standing-frame.wgsl `TreeFrame`): five vec4f,
 * the light, the crown's colour, the crown's shade, the trunk's colour, and
 * the crown's radius and centre height in the model's metres.
 */
export const TreeFrameUniformLayout = {
  byteLength: 80,
  lightDirection: 0,
  crownColor: 16,
  crownShadeColor: 32,
  trunkColor: 48,
  crown: 64,
} as const;

/**
 * The extruded vertex: the position fetched as four sint16 (the fourth
 * unused), the normal as snorm8, the style index and the building's ordinal
 * in its tile, which the relief lifts the building by.
 */
const extrudedVertexLayout: GPUVertexBufferLayout = {
  arrayStride: EXTRUDED_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "sint16x4" },
    { shaderLocation: 1, offset: 6, format: "snorm8x2" },
    { shaderLocation: 2, offset: 8, format: "snorm8" },
    { shaderLocation: 3, offset: 9, format: "uint8" },
    { shaderLocation: 4, offset: 10, format: "uint16" },
  ],
};

const extrudedCasterVertexLayout: GPUVertexBufferLayout = {
  arrayStride: EXTRUDED_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "sint16x4" },
    { shaderLocation: 4, offset: 10, format: "uint16" },
  ],
};

/** The buildings' lift uniform (tile-extruded.wgsl `BuildingLift`): the world units a metre rises by, the datum, the strength. */
export const BUILDING_LIFT_UNIFORM_BYTES = 16;

/** The model file's 20-byte vertex (`TreeModelContents`): the position, the normal and the shading. */
const treeModelVertexLayout: GPUVertexBufferLayout = {
  arrayStride: TreeModelContents.vertexStride,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
  ],
};

const treeInstanceLayout: GPUVertexBufferLayout = {
  arrayStride: TREE_INSTANCE_STRIDE,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 3, offset: 0, format: "float32x2" },
    { shaderLocation: 4, offset: 8, format: "float32" },
    { shaderLocation: 5, offset: 12, format: "uint32" },
  ],
};

/** The scene depth with the surface mask bit raised where the surface lands. */
function surfaceMaskDepthStencil(format: GPUTextureFormat): GPUDepthStencilState {
  const face: GPUStencilFaceState = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
  return {
    format,
    depthWriteEnabled: true,
    depthCompare: "less-equal",
    stencilFront: face,
    stencilBack: face,
    stencilReadMask: TileSourceStencilPriority.priorityMask,
    stencilWriteMask: TileSourceStencilPriority.surfaceMaskBit,
  };
}

/** The ground's depth test, nothing written. */
function groundDepthStencil(format: GPUTextureFormat): GPUDepthStencilState {
  return { format, depthWriteEnabled: false, depthCompare: "less", stencilWriteMask: 0 };
}

/** The colour multiplied into the ground under it, the alpha kept. */
const multiplyBlend: GPUBlendState = {
  color: { operation: "add", srcFactor: "dst", dstFactor: "zero" },
  alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" },
};

export class StandingPipelines {
  readonly standingFrameLayout: GPUBindGroupLayout;
  readonly extrudedStylesLayout: GPUBindGroupLayout;
  readonly treeTileLayout: GPUBindGroupLayout;
  /** The casters' group 0: they read nothing of the frame. */
  readonly emptyLayout: GPUBindGroupLayout;
  readonly emptyGroup: GPUBindGroup;
  /** A tile's lifts over the relief and the frame's lift uniform (the extruded pipelines' group 3, `kExtrudedRelief`). */
  readonly liftsLayout: GPUBindGroupLayout;
  private built:
    | { building: GPURenderPipeline; buildingRelief: GPURenderPipeline; caster: GPURenderPipeline; casterRelief: GPURenderPipeline; tree: GPURenderPipeline; treeShadow: GPURenderPipeline }
    | undefined;

  constructor(
    private readonly context: TilePipelineContext,
    /** The per-draw records' layout (`FlatTilePipelines.drawLayout`). */
    readonly drawLayout: GPUBindGroupLayout,
  ) {
    const { device } = context;
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const fragment = GPUShaderStage.FRAGMENT;
    this.standingFrameLayout = device.createBindGroupLayout({
      label: "standing frame",
      entries: [
        { binding: 0, visibility: both, buffer: {} },
        { binding: 1, visibility: fragment, buffer: {} },
        { binding: 2, visibility: fragment, buffer: {} },
        { binding: 3, visibility: fragment, texture: { sampleType: "depth", viewDimension: "2d-array" } },
        { binding: 4, visibility: fragment, sampler: { type: "comparison" } },
        { binding: 5, visibility: fragment, buffer: {} },
        { binding: 6, visibility: both, buffer: {} },
      ],
    });
    this.extrudedStylesLayout = device.createBindGroupLayout({
      label: "extruded styles",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage", minBindingSize: 16 } }],
    });
    this.treeTileLayout = device.createBindGroupLayout({
      label: "tree tile",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true, minBindingSize: TREE_TILE_BYTES } }],
    });
    this.liftsLayout = device.createBindGroupLayout({
      label: "building lifts",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage", minBindingSize: 4 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { minBindingSize: BUILDING_LIFT_UNIFORM_BYTES } },
      ],
    });
    this.emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    this.emptyGroup = device.createBindGroup({ label: "empty", layout: this.emptyLayout, entries: [] });
  }

  get building(): GPURenderPipeline {
    return this.pipelines().building;
  }

  get caster(): GPURenderPipeline {
    return this.pipelines().caster;
  }

  /** The buildings on the relief, each lifted by its tile's lifts. */
  get buildingRelief(): GPURenderPipeline {
    return this.pipelines().buildingRelief;
  }

  get casterRelief(): GPURenderPipeline {
    return this.pipelines().casterRelief;
  }

  get tree(): GPURenderPipeline {
    return this.pipelines().tree;
  }

  get treeShadow(): GPURenderPipeline {
    return this.pipelines().treeShadow;
  }

  /** Builds every pipeline up front, so no frame stalls on a compile. */
  async prewarm(): Promise<void> {
    if (this.built) return;
    const d = this.descriptors();
    const { device } = this.context;
    const [building, buildingRelief, caster, casterRelief, tree, treeShadow] = await Promise.all(
      [d.building, d.buildingRelief, d.caster, d.casterRelief, d.tree, d.treeShadow].map((x) => device.createRenderPipelineAsync(x)),
    );
    this.built ??= { building: building!, buildingRelief: buildingRelief!, caster: caster!, casterRelief: casterRelief!, tree: tree!, treeShadow: treeShadow! };
  }

  private pipelines(): NonNullable<StandingPipelines["built"]> {
    if (!this.built) {
      const d = this.descriptors();
      const { device } = this.context;
      this.built = {
        building: device.createRenderPipeline(d.building),
        buildingRelief: device.createRenderPipeline(d.buildingRelief),
        caster: device.createRenderPipeline(d.caster),
        casterRelief: device.createRenderPipeline(d.casterRelief),
        tree: device.createRenderPipeline(d.tree),
        treeShadow: device.createRenderPipeline(d.treeShadow),
      };
    }
    return this.built;
  }

  private descriptors(): Record<"building" | "buildingRelief" | "caster" | "casterRelief" | "tree" | "treeShadow", GPURenderPipelineDescriptor> {
    const { device, colorFormat, depthStencilFormat, sampleCount } = this.context;
    const prefix = [shadowLibrary, groundFog, standingFrame].join("\n");
    const extrudedModule = device.createShaderModule({ label: "tile extruded", code: prefix + "\n" + extruded });
    const treeModule = device.createShaderModule({ label: "trees", code: prefix + "\n" + trees });
    const worldLayout = device.createPipelineLayout({ bindGroupLayouts: [this.standingFrameLayout, this.drawLayout, this.extrudedStylesLayout, this.liftsLayout] });
    const casterLayout = device.createPipelineLayout({ bindGroupLayouts: [this.emptyLayout, this.drawLayout, this.emptyLayout, this.liftsLayout] });
    const treeLayout = device.createPipelineLayout({ bindGroupLayouts: [this.standingFrameLayout, this.treeTileLayout] });
    const multisample = { count: sampleCount };
    // The walls and the lids are wound clockwise (the exterior ring is
    // forced clockwise by the parser), so their front face is clockwise.
    const building = (relief: boolean): GPURenderPipelineDescriptor => ({
      label: `tile extruded${relief ? " relief" : ""}`,
      layout: worldLayout,
      vertex: { module: extrudedModule, entryPoint: "tileExtrudedVertex", constants: { kExtrudedRelief: relief ? 1 : 0 }, buffers: [extrudedVertexLayout] },
      fragment: { module: extrudedModule, entryPoint: "tileExtrudedFragment", targets: [{ format: colorFormat }] },
      primitive: { topology: "triangle-list", frontFace: "cw", cullMode: "back" },
      depthStencil: surfaceMaskDepthStencil(depthStencilFormat),
      multisample,
    });
    // Both faces, depth only: drawing both partly covers the wall quads
    // missing on tile boundaries. No depth bias: the receivers carry it.
    const caster = (relief: boolean): GPURenderPipelineDescriptor => ({
      label: `tile extruded caster${relief ? " relief" : ""}`,
      layout: casterLayout,
      vertex: { module: extrudedModule, entryPoint: "tileExtrudedShadowVertex", constants: { kExtrudedRelief: relief ? 1 : 0 }, buffers: [extrudedCasterVertexLayout] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ShadowCascadeAtlas.depthFormat, depthWriteEnabled: true, depthCompare: "less-equal" },
    });
    return {
      building: building(false),
      buildingRelief: building(true),
      caster: caster(false),
      casterRelief: caster(true),
      // The model's triangles are wound counter-clockwise seen from outside.
      tree: {
        label: "trees",
        layout: treeLayout,
        vertex: { module: treeModule, entryPoint: "treeVertex", buffers: [treeModelVertexLayout, treeInstanceLayout] },
        fragment: { module: treeModule, entryPoint: "treeFragment", targets: [{ format: colorFormat }] },
        primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
        depthStencil: surfaceMaskDepthStencil(depthStencilFormat),
        multisample,
      },
      treeShadow: {
        label: "tree shadows",
        layout: treeLayout,
        vertex: { module: treeModule, entryPoint: "treeShadowVertex", buffers: [treeInstanceLayout] },
        fragment: { module: treeModule, entryPoint: "treeShadowFragment", targets: [{ format: colorFormat, blend: multiplyBlend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: groundDepthStencil(depthStencilFormat),
        multisample,
      },
    };
  }
}

/** Writes the trees' frame uniform: the light normalized, the palette, the crown by the model. */
export function writeTreeFrameUniform(
  target: Float32Array,
  light: readonly [number, number, number],
  palette: { readonly crownColor: readonly number[]; readonly crownShadeColor: readonly number[]; readonly trunkColor: readonly number[] },
  crownRadiusMetres: number,
  crownCentreHeightMetres: number,
): void {
  const L = TreeFrameUniformLayout;
  const length = Math.hypot(light[0], light[1], light[2]) || 1;
  target.fill(0);
  target.set([light[0] / length, light[1] / length, light[2] / length, 0], L.lightDirection / 4);
  target.set([palette.crownColor[0]!, palette.crownColor[1]!, palette.crownColor[2]!, 1], L.crownColor / 4);
  target.set([palette.crownShadeColor[0]!, palette.crownShadeColor[1]!, palette.crownShadeColor[2]!, 1], L.crownShadeColor / 4);
  target.set([palette.trunkColor[0]!, palette.trunkColor[1]!, palette.trunkColor[2]!, 1], L.trunkColor / 4);
  target.set([crownRadiusMetres, crownCentreHeightMetres, 0, 0], L.crown / 4);
}
