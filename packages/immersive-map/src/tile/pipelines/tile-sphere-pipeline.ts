// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The globe's tile pipelines, a port of the sphere half of the Swift
 * `TilePipeline` with the depth-stencil states of `SharedRenderResources`
 * (in WebGPU the state is the pipeline's). One shader (tile-sphere.wgsl),
 * each class on the resting sphere and through the unroll (`kGlobeMorph`):
 *
 * - `opaqueFills`: unblended, the rank band written (less-equal) under the
 *   tile-priority test on the priority bits alone (the Swift
 *   `sphereOpaqueOwnerState`).
 * - `fills`: the translucent fills, blended, tested only (`tileStencilTestState`).
 * - `ribbons`: the line ribbons whole, blended, tested only.
 * - `ribbonCores` / `ribbonFeathers`: the two phases a frame with a veiled
 *   stroke draws its ribbons in. The cores write the rank under a strict
 *   test (`sphereRibbonOwnerState`), the feathers blend over them, tested only.
 *
 * The same states as the plane's classes, so `flatTileDepthStencil` states them.
 */

import { globeModuleSource } from "../../globe/globe-shader-source.ts";
import shading from "../shaders/tile-shading.wgsl?raw";
import sphere from "../shaders/tile-sphere.wgsl?raw";
import { type FlatTileClass, flatTileDepthStencil, tileBlend, tileVertexLayout, type TilePipelineContext } from "./tile-pipeline.ts";
import { stageEntry } from "../../render/core/stage-constants.ts";

export type SphereTileClass = "opaqueFills" | "fills" | "ribbons" | "ribbonCores" | "ribbonFeathers";

const sphereTileClasses: readonly SphereTileClass[] = ["opaqueFills", "fills", "ribbons", "ribbonCores", "ribbonFeathers"];

/** The plane's class whose depth-stencil state a sphere class draws under. */
const depthStencilClass: Record<SphereTileClass, FlatTileClass> = {
  opaqueFills: "opaqueFills",
  fills: "fills",
  ribbons: "lines",
  ribbonCores: "roadOpaque",
  ribbonFeathers: "lines",
};

/** `kTileSphereRibbonPhase` of a class: 0 whole, 1 core, 2 feather. */
const ribbonPhase: Record<SphereTileClass, number> = { opaqueFills: 0, fills: 0, ribbons: 0, ribbonCores: 1, ribbonFeathers: 2 };

export interface SphereTileLayouts {
  readonly frameLayout: GPUBindGroupLayout;
  readonly drawLayout: GPUBindGroupLayout;
  readonly stylesLayout: GPUBindGroupLayout;
}

export class SphereTilePipelines {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly layout: GPUPipelineLayout;
  private readonly module: GPUShaderModule;
  /** The module's source, which says the overrides each entry point uses (`stageEntry`). */
  private readonly code: string;
  /** The per-draw storage array's layout (group 1), the plane's. */
  readonly drawLayout: GPUBindGroupLayout;

  constructor(
    private readonly context: TilePipelineContext,
    layouts: SphereTileLayouts,
    clipDistances: boolean,
  ) {
    const { device } = context;
    this.drawLayout = layouts.drawLayout;
    this.layout = device.createPipelineLayout({ label: "tile sphere", bindGroupLayouts: [layouts.frameLayout, layouts.drawLayout, layouts.stylesLayout] });
    this.code = globeModuleSource(clipDistances, [shading], sphere);
    this.module = device.createShaderModule({ label: "tile sphere", code: this.code });
  }

  pipeline(tileClass: SphereTileClass, morph: boolean): GPURenderPipeline {
    const key = `${tileClass}/${morph}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.context.device.createRenderPipeline(this.descriptor(tileClass, morph));
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Builds every class of both worlds up front, so no frame stalls on a compile. */
  async prewarm(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const tileClass of sphereTileClasses) {
      for (const morph of [false, true]) {
        const key = `${tileClass}/${morph}`;
        if (this.pipelines.has(key)) continue;
        work.push(
          this.context.device.createRenderPipelineAsync(this.descriptor(tileClass, morph)).then((pipeline) => {
            this.pipelines.set(key, pipeline);
          }),
        );
      }
    }
    await Promise.all(work);
  }

  private descriptor(tileClass: SphereTileClass, morph: boolean): GPURenderPipelineDescriptor {
    const { colorFormat, depthStencilFormat, sampleCount } = this.context;
    const constants: Record<string, number> = {
      kGlobeMorph: morph ? 1 : 0,
      kTileLineFields: tileClass === "opaqueFills" || tileClass === "fills" ? 0 : 1,
      kTileSphereRibbonPhase: ribbonPhase[tileClass],
    };
    const blended = tileClass !== "opaqueFills";
    return {
      label: `tile sphere ${tileClass}${morph ? " morph" : ""}`,
      layout: this.layout,
      vertex: { module: this.module, ...stageEntry(this.code, "tileSphereVertex", constants), buffers: [tileVertexLayout] },
      fragment: {
        module: this.module,
        ...stageEntry(this.code, "tileSphereFragment", constants),
        targets: [{ format: colorFormat, ...(blended ? { blend: tileBlend } : {}) }],
      },
      // Every tile triangle is counter-clockwise in render space and the
      // sphere projection does not mirror: culling back faces removes the
      // far side of the planet by orientation alone.
      primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
      depthStencil: flatTileDepthStencil(depthStencilFormat, depthStencilClass[tileClass]),
      multisample: { count: sampleCount },
    };
  }
}
