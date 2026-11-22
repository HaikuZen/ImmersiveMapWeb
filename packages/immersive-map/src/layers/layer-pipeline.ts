// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import groundFog from "../ground-fog/shaders/ground-fog.wgsl?raw";
import { globeModuleSource } from "../globe/globe-shader-source.ts";
import { GlobeSurfaceDepthRank, TileSourceStencilPriority } from "../tile/drawers/depth-rank.ts";
import { LayerMeshLayout } from "./cache/layer-mesh-file.ts";
import layersSource from "./shaders/layers.wgsl?raw";

/** The surface the frame draws the layers on, `kLayerSurface` in layers.wgsl. */
export type LayerSurface = "flat" | "sphere" | "morph";

const surfaceValue: Record<LayerSurface, number> = { flat: 0, sphere: 1, morph: 2 };

/** The pipelines of one surface and one depth test. */
export interface LayerPipelineStates {
  readonly fill: GPURenderPipeline;
  readonly line: GPURenderPipeline;
  readonly point: GPURenderPipeline;
}

export interface LayerPipelineContext {
  readonly device: GPUDevice;
  readonly colorFormat: GPUTextureFormat;
  readonly depthStencilFormat: GPUTextureFormat;
  readonly sampleCount: number;
  readonly clipDistances: boolean;
  /** The tile pipelines' frame layout (camera, fog, globe), group 0. */
  readonly frameLayout: GPUBindGroupLayout;
  /** The draw-parameter layout (B6), group 1. */
  readonly drawLayout: GPUBindGroupLayout;
}

/**
 * The triangles of one segment's shape, over the ten corners the vertex
 * stage places (layers.wgsl): the body, then half an octagon at the start
 * and one at the end.
 */
export const LAYER_LINE_TEMPLATE: readonly number[] = [0, 1, 5, 5, 1, 6, 0, 2, 4, 0, 4, 3, 0, 3, 1, 5, 7, 9, 5, 9, 8, 5, 8, 6];
/** The vertex indices a line's or a disc's draw takes a record (`kLayerCornerSlots`): the draw's base vertex is its record times this. */
export const LAYER_CORNER_SLOTS = 16;

/**
 * Where the layers sit in the ground's far-plane depth band (the Swift
 * `LayerDepth`): a step behind the labels painted on the map, which draw over
 * them, and nearer than the ground and the roads, so a layer lies over those
 * and every building and model stays in front of it.
 */
export const LayerDepth = {
  depth: 1 - GlobeSurfaceDepthRank.appLayersRank * GlobeSurfaceDepthRank.layerDepthStep,
} as const;

/** A fill and a disc may be translucent: blended like the ground. */
const blend: GPUBlendState = {
  color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

const fillBuffers: GPUVertexBufferLayout[] = [
  {
    arrayStride: LayerMeshLayout.fillVertexStride,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "unorm8x4" },
    ],
  },
];

const lineBuffers: GPUVertexBufferLayout[] = [
  {
    arrayStride: LayerMeshLayout.lineSegmentStride,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "float32x2" },
      { shaderLocation: 2, offset: 16, format: "float32" },
      { shaderLocation: 3, offset: 20, format: "uint8x4" },
    ],
  },
];

const pointBuffers: GPUVertexBufferLayout[] = [
  {
    arrayStride: LayerMeshLayout.discStride,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" },
      { shaderLocation: 1, offset: 8, format: "float32" },
      { shaderLocation: 2, offset: 12, format: "float32" },
      { shaderLocation: 3, offset: 16, format: "unorm8x4" },
      { shaderLocation: 4, offset: 20, format: "unorm8x4" },
    ],
  },
];

/**
 * The pipelines of the layers of the app's data (layers.wgsl), the Swift
 * `LayerPipeline`: zones, lines and discs, each in one variant per surface
 * the ground is drawn on and per depth test, in the world pass's formats and
 * sample count. A layer is never tested against the ground's depth
 * (`over`) or is, so the relief nearer the camera hides it (`behind`,
 * `ImmersiveMapLayer.hidesBehindTerrain`). Both test the surface mask bit
 * the buildings, the models and the trees raise where they stand
 * (`TileSourceStencilPriority`), as the roads do, so whatever stands in front
 * of a layer covers it, and neither writes depth or stencil. The stencil
 * reference is zero. A line is solid and its shape is its geometry, so it
 * draws without blending.
 *
 * The pipelines are compiled once a layer first has something to draw, so a
 * map without layers compiles none of them.
 */
export class LayerPipeline {
  /** The index buffer every segment draws by (`LAYER_LINE_TEMPLATE`). */
  readonly lineTemplateIndices: GPUBuffer;
  private states: Map<string, LayerPipelineStates> | undefined;
  private compiling: Promise<void> | undefined;
  private failed = false;

  constructor(readonly context: LayerPipelineContext) {
    const indices = new Uint16Array(LAYER_LINE_TEMPLATE);
    this.lineTemplateIndices = context.device.createBuffer({ label: "layer line template", size: indices.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint16Array(this.lineTemplateIndices.getMappedRange()).set(indices);
    this.lineTemplateIndices.unmap();
  }

  /** Whether the pipelines are compiled. */
  get isReady(): boolean {
    return this.states !== undefined;
  }

  /** Compiles the pipelines, once: `onReady` is called when they are. */
  prepare(onReady: () => void): void {
    if (this.compiling !== undefined || this.failed) return;
    this.compiling = this.compile()
      .then((states) => {
        this.states = states;
        onReady();
      })
      .catch((error: unknown) => {
        this.failed = true;
        console.error(`ImmersiveMap could not compile the layers' pipelines: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** The pipelines of a surface and a depth test, `undefined` until they are compiled. */
  statesFor(surface: LayerSurface, behindTerrain: boolean): LayerPipelineStates | undefined {
    return this.states?.get(`${surface}/${behindTerrain ? "behind" : "over"}`);
  }

  destroy(): void {
    this.lineTemplateIndices.destroy();
  }

  private async compile(): Promise<Map<string, LayerPipelineStates>> {
    const { device, colorFormat, depthStencilFormat, sampleCount, clipDistances } = this.context;
    const module = device.createShaderModule({ label: "layers", code: globeModuleSource(clipDistances, [groundFog], layersSource) });
    const layout = device.createPipelineLayout({ label: "layers", bindGroupLayouts: [this.context.frameLayout, this.context.drawLayout] });
    const stencil: GPUStencilFaceState = { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
    const make = (surface: LayerSurface, behind: boolean, kind: "fill" | "line" | "point"): Promise<GPURenderPipeline> => {
      const constants = { kLayerSurface: surfaceValue[surface] };
      const vertex: GPUVertexState = { module, entryPoint: `layer${capitalized(kind)}Vertex`, constants, buffers: kind === "fill" ? fillBuffers : kind === "line" ? lineBuffers : pointBuffers };
      const fragment: GPUFragmentState = {
        module,
        entryPoint: `layer${capitalized(kind)}Fragment`,
        constants,
        targets: [kind === "line" ? { format: colorFormat } : { format: colorFormat, blend }],
      };
      return device.createRenderPipelineAsync({
        label: `layers ${kind} ${surface} ${behind ? "behind terrain" : "over ground"}`,
        layout,
        vertex,
        fragment,
        // A zone's triangles are counter-clockwise in render space, as the
        // ground's: culling the back faces removes the far side of the
        // planet. A line's and a point's quads are cut there instead.
        primitive: kind === "fill" ? { topology: "triangle-list", frontFace: "ccw", cullMode: "back" } : { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: depthStencilFormat,
          depthWriteEnabled: false,
          depthCompare: behind ? "less" : "always",
          stencilFront: stencil,
          stencilBack: stencil,
          stencilReadMask: TileSourceStencilPriority.surfaceMaskBit,
          stencilWriteMask: 0,
        },
        multisample: { count: sampleCount },
      });
    };
    const entries: Promise<[string, LayerPipelineStates]>[] = [];
    for (const surface of ["flat", "sphere", "morph"] as const) {
      for (const behind of [false, true]) {
        entries.push(Promise.all([make(surface, behind, "fill"), make(surface, behind, "line"), make(surface, behind, "point")]).then(([fill, line, point]) => [`${surface}/${behind ? "behind" : "over"}`, { fill, line, point }]));
      }
    }
    return new Map(await Promise.all(entries));
  }
}

function capitalized(kind: string): string {
  return kind[0]!.toUpperCase() + kind.slice(1);
}
