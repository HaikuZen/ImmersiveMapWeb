// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The globe's subsystems: its vector ground (the Swift
 * `GlobeVectorSurfaceRenderSubsystem`) and its polar caps (the Swift
 * `GlobeCapPipeline`, `GlobeCapRenderer` and `GlobeCapRenderSubsystem`).
 * Both draw on the sphere and through the unroll, by the frame's globe
 * uniform (binding 3 of the frame group), and nothing on the plane.
 */

import type { ImmersiveMapBaseColors } from "../style/theme.ts";
import { WebMercatorMath } from "../math/web-mercator-math.ts";
import type { RenderLayer } from "../render/core/render-layer.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import type { SphereTilePipelines } from "../tile/pipelines/tile-sphere-pipeline.ts";
import { tileBlend, type TilePipelineContext } from "../tile/pipelines/tile-pipeline.ts";
import type { TileFrameState } from "../tile/subsystems/flat-tile-subsystems.ts";
import { GlobeCapGeometry, type GlobeCapGrid, GlobeCapPalette } from "./globe-cap-geometry.ts";
import { GlobeSphereVertexPath } from "./globe-frame-constants.ts";
import { GlobeVectorSurfaceDrawer } from "./globe-vector-surface-drawer.ts";
import capSource from "./shaders/globe-cap.wgsl?raw";
import globeSource from "./shaders/globe.wgsl?raw";

/**
 * The globe's ground: the placements' ground geometry projected onto the
 * sphere in the vertex stage. A tile's extent is its full square: which
 * source owns a pixel is the planner's decision, marked by the placement
 * prepass in the tile-priority stencil and tested by every pass, and the far
 * hemisphere goes to back-face culling.
 */
export class GlobeVectorSurfaceSubsystem implements RenderSubsystem {
  readonly name = "GlobeVectorSurface";
  readonly layers: readonly RenderLayer[] = ["globeVectorSurface"];
  private readonly drawer: GlobeVectorSurfaceDrawer;

  constructor(
    pipelines: SphereTilePipelines,
    private readonly state: () => TileFrameState,
  ) {
    this.drawer = new GlobeVectorSurfaceDrawer(pipelines);
  }

  encode(_layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    const { placements, renderSurfaceMode, globe, flatRenderState } = this.state();
    if (renderSurfaceMode !== "spherical" || placements.length === 0) return;
    this.drawer.draw(
      pass,
      {
        frameBindGroup: context.frameBindGroup,
        drawParameters: context.drawParameters,
        cameraZoom: context.planningZoom,
        pixelsPerPoint: context.pixelsPerPoint,
        drawHeightPx: context.drawHeight,
        renderMapSize: flatRenderState.renderMapSize,
        morph: !GlobeSphereVertexPath.isPureSphere(renderSurfaceMode, globe.transition),
      },
      this.drawer.sources(placements),
    );
  }
}

/** One cap on the GPU. */
interface CapBuffers {
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat;
}

/**
 * The polar caps: the sphere beyond the Mercator edge, drawn after the tile
 * geometry in the constant colours the style states for them. Two fan draws
 * with one colour each, culling back faces as the tiles do (nothing writes
 * surface depth on the sphere, and without the cull the back of the fan
 * would draw through the planet), under the scene depth tested less-equal
 * and never written (the Swift `globeCapDepthState`). They fade out over the
 * first third of the unroll (globe-cap.wgsl).
 */
export class GlobeCapSubsystem implements RenderSubsystem {
  readonly name = "GlobeCap";
  readonly layers: readonly RenderLayer[] = ["globeCap"];
  private readonly pipeline: GPURenderPipeline;
  private readonly caps: readonly [CapBuffers, CapBuffers];
  private readonly drawLayout: GPUBindGroupLayout;

  constructor(
    context: TilePipelineContext,
    layouts: { readonly frameLayout: GPUBindGroupLayout; readonly drawLayout: GPUBindGroupLayout },
    private readonly state: () => TileFrameState,
    private readonly baseColors: () => ImmersiveMapBaseColors,
    stacks = 12,
    slices = 48,
  ) {
    const { device, colorFormat, depthStencilFormat, sampleCount } = context;
    this.drawLayout = layouts.drawLayout;
    const module = device.createShaderModule({ label: "globe cap", code: globeSource + "\n" + capSource });
    const keep: GPUStencilFaceState = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
    this.pipeline = device.createRenderPipeline({
      label: "globe cap",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frameLayout, layouts.drawLayout] }),
      vertex: { module, entryPoint: "globeCapVertex", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
      fragment: { module, entryPoint: "globeCapFragment", targets: [{ format: colorFormat, blend: tileBlend }] },
      primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
      depthStencil: { format: depthStencilFormat, depthWriteEnabled: false, depthCompare: "less-equal", stencilFront: keep, stencilBack: keep, stencilReadMask: 0, stencilWriteMask: 0 },
      multisample: { count: sampleCount },
    });
    const upload = (grid: GlobeCapGrid): CapBuffers => {
      const make = (data: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number) => {
        const buffer = device.createBuffer({ label: "globe cap", size: Math.ceil(data.byteLength / 4) * 4, usage, mappedAtCreation: true });
        new Uint8Array(buffer.getMappedRange(), 0, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        buffer.unmap();
        return buffer;
      };
      return {
        vertices: make(grid.latLon, GPUBufferUsage.VERTEX),
        indices: make(grid.indices, GPUBufferUsage.INDEX),
        indexCount: grid.indices.length,
        indexFormat: grid.indices instanceof Uint16Array ? "uint16" : "uint32",
      };
    };
    const maxLatitude = WebMercatorMath.maxLatitudeRadians;
    this.caps = [
      upload(GlobeCapGeometry.createCapGrid(stacks, slices, true, maxLatitude)),
      upload(GlobeCapGeometry.createCapGrid(stacks, slices, false, maxLatitude)),
    ];
  }

  encode(_layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    if (this.state().renderSurfaceMode !== "spherical") return;
    const palette = GlobeCapPalette.make(this.baseColors());
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, context.frameBindGroup);
    const colors = [palette.north, palette.south] as const;
    for (let pole = 0; pole < 2; pole++) {
      const cap = this.caps[pole]!;
      const record = context.drawParameters.allocate();
      context.drawParameters.f32.set(colors[pole]!, record.index);
      pass.setBindGroup(1, context.drawParameters.bindGroup(this.drawLayout));
      pass.setVertexBuffer(0, cap.vertices);
      pass.setIndexBuffer(cap.indices, cap.indexFormat);
      pass.drawIndexed(cap.indexCount, 1, 0, 0, record.instance);
    }
  }

  destroy(): void {
    for (const cap of this.caps) {
      cap.vertices.destroy();
      cap.indices.destroy();
    }
  }
}
