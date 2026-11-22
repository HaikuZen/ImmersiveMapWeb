// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The map's frame: a port of the Swift `RenderFrameEngine`'s workflow
 * (collect input, update the scene, prepare the GPU, encode the passes,
 * present). It owns the frame attachments and the render graph, and knows
 * the features only through `RenderSubsystem`: each feature encodes its own
 * layers.
 *
 * Rendering is on demand: the host asks for a frame when something changed
 * and the engine draws exactly one.
 */

import type { GpuContext } from "./core/gpu-context.ts";
import { type RenderLayer, isOverlayLayer, isWorldLayer, planRenderLayers, type RenderPassAvailability, worldLayerOrder } from "./core/render-layer.ts";
import { DrawParameters } from "./core/draw-parameters.ts";

/** What every subsystem reads of a frame. */
export interface FrameContext {
  readonly frameNumber: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly pixelsPerPoint: number;
  /** The camera's planning zoom, the one tiles and style fades answer. */
  readonly planningZoom: number;
  /** The frame's camera and overview-fade uniforms (group 0 of the tile pipelines). */
  readonly frameBindGroup: GPUBindGroup;
  /** Per-draw parameters, written during encoding and flushed before submit. */
  readonly drawParameters: DrawParameters;
  /**
   * The world pass's depth, single-sample, for the overlay pass to test
   * against (`FrameSetup.keepsSceneDepth`, `FrameEngine.sceneDepth`):
   * `undefined` on a frame that does not keep it. Written by the world
   * pass, so only the overlay may read it.
   */
  readonly sceneDepth?: GPUTextureView | undefined;
}

/**
 * A feature's drawing, the Swift `RenderSubsystem`: prepares its GPU state
 * once a frame, then encodes the layers it owns into the pass that hosts them.
 */
export interface RenderSubsystem {
  readonly name: string;
  readonly layers: readonly RenderLayer[];
  update?(context: FrameContext): void;
  /**
   * Encodes the work the frame's passes read. A compute pass takes the
   * `timestampWrites` of `timestamps(label)`, so the frame's GPU time
   * (and the profile) counts it.
   */
  prepareGPU?(context: FrameContext, encoder: GPUCommandEncoder, timestamps: (label: string) => { timestampWrites?: GPUComputePassTimestampWrites }): void;
  encode(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void;
  /**
   * After `update`: what the subsystem's content enables in the frame's
   * passes (the Swift `RenderPassAvailabilityProvider`), such as the labels'
   * layer when the frame has labels to draw.
   */
  contributeAvailability?(availability: RenderPassAvailability): void;
  /** After the frame's submit: only now has the GPU work encoded in `prepareGPU` run. */
  frameCommitted?(): void;
}

export interface FrameSetup {
  availability: RenderPassAvailability;
  clearColor: GPUColor;
  sampleCount: number;
  /**
   * The frame's shadow passes, planned once the subsystems have updated
   * (the Swift `RenderPassGraph.plan`, whose shadow gate reads what the
   * buildings drew) and before they prepare the GPU.
   */
  planShadowPasses?: () => ShadowPassPlan;
  /** FXAA over the world pass (`planRenderFrameOutput`): the world draws into the post-processing input. */
  fxaa?: boolean;
  /**
   * Keep the world pass's depth for the overlay pass (`sceneDepth`): the road
   * names hidden behind the buildings (`LabelRoadSettings.hidesBehindBuildingsFromZoom`).
   * Off, the depth is dropped when the world pass ends, as always.
   */
  keepsSceneDepth?: boolean;
}

/** The shadow passes of a frame, before everything the world samples them in. */
export interface ShadowPassPlan {
  /**
   * One depth-only pass a window whose slice went stale
   * (`ShadowMapReuseController`), each encoding its caster layer into the
   * slice's view. Empty when the map is reused or there are no shadows.
   */
  readonly casterPasses: readonly {
    readonly layer: RenderLayer;
    readonly view: GPUTextureView;
    /** Draw over the depth the slice holds instead of clearing it: the pass changes some casters alone (`ShadowCasterPassPlan`). */
    readonly keepsDepth?: boolean;
    /** Encoded before the casters: the scissor and the clear of the part of a kept slice the pass draws again. */
    readonly encodeFirst?: (pass: GPURenderPassEncoder) => void;
  }[];
  /** The ground shadow mask's view when the shadow gate is open: its pass follows the casters. */
  readonly groundShadowMask: GPUTextureView | undefined;
}

const noShadowPasses: ShadowPassPlan = { casterPasses: [], groundShadowMask: undefined };

/** The passes a profiled frame times at most. */
const profilingSlots = 32;

export class FrameEngine {
  private readonly subsystems: RenderSubsystem[] = [];
  private readonly flushes: (() => void)[] = [];
  private colorTexture: GPUTexture | undefined;
  private depthTexture: GPUTexture | undefined;
  /** The world's depth kept for the overlay: the depth texture itself with one sample, its sample 0 resolved into this with several. */
  private sceneDepthTexture: GPUTexture | undefined;
  private sceneDepthViewOfFrame: GPUTextureView | undefined;
  private sceneDepthResolve: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout; group: GPUBindGroup | undefined; source: GPUTexture | undefined } | undefined;
  private overlayDepthTexture: GPUTexture | undefined;
  /** What the world pass draws into when FXAA follows it (the Swift post-processing input). */
  private postProcessingTexture: GPUTexture | undefined;
  readonly drawParameters: DrawParameters;
  private frameNumber = 0;
  private cachedPlan: { availability: RenderPassAvailability; world: RenderLayer[]; overlay: RenderLayer[] } | undefined;
  /** The GPU time of the last measured frame, from its first pass's start to its last pass's end, in ms (timestamp-query). */
  gpuMilliseconds: number | undefined;
  private readonly timing: { querySet: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; reading: boolean } | undefined;
  /** Debug: time every pass of a frame into `passProfile`. Needs the timestamp queries. */
  profilesPasses = false;
  /**
   * Debug, with `profilesPasses`: the world pass layer by layer, each world
   * layer in a pass of its own that loads and stores the attachments (which
   * adds its own cost to every layer's time).
   */
  profilesWorldLayers = false;
  /**
   * Each pass of the last profiled frame, in the order they ran: its start
   * after the first pass's start and its GPU time, in ms.
   */
  passProfile: readonly { readonly name: string; readonly start: number; readonly milliseconds: number }[] | undefined;
  private profiling: { querySet: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; reading: boolean } | undefined;

  private alphaMode: GPUCanvasAlphaMode | undefined;

  constructor(
    readonly gpu: GpuContext,
    private readonly context: GPUCanvasContext,
    /** Whether the page shows through the canvas (the transparent space of the scene settings). */
    transparent = false,
  ) {
    this.setTransparent(transparent);
    this.drawParameters = new DrawParameters(gpu.device, "draw parameters");
    if (gpu.capabilities.timestampQuery) {
      const { device } = gpu;
      this.timing = {
        querySet: device.createQuerySet({ type: "timestamp", count: 2 }),
        resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        reading: false,
      };
    }
  }

  register(subsystem: RenderSubsystem): void {
    this.subsystems.push(subsystem);
  }

  /**
   * A buffer the frame's draws fill while they encode, written to the GPU
   * once they are done and before the submit, as the draw parameters are
   * (the ground relief's uniforms).
   */
  registerFlush(flush: () => void): void {
    this.flushes.push(flush);
  }

  /** One frame. `makeContext` builds the frame's context once the attachments are known. */
  frame(setup: FrameSetup, drawWidth: number, drawHeight: number, makeContext: (frameNumber: number) => FrameContext): void {
    if (drawWidth <= 0 || drawHeight <= 0) return;
    const { device } = this.gpu;
    this.frameNumber++;
    const fxaa = setup.fxaa === true;
    this.ensureAttachments(drawWidth, drawHeight, setup.sampleCount, fxaa);
    const keepsSceneDepth = setup.keepsSceneDepth === true;
    this.sceneDepthViewOfFrame = keepsSceneDepth ? this.ensureSceneDepth(drawWidth, drawHeight, setup.sampleCount) : undefined;
    this.drawParameters.reset();
    const context = makeContext(this.frameNumber);
    for (const s of this.subsystems) s.update?.(context);
    const availability = { ...setup.availability };
    for (const s of this.subsystems) s.contributeAvailability?.(availability);
    const shadowPlan = setup.planShadowPasses?.() ?? noShadowPasses;

    const encoder = device.createCommandEncoder({ label: "frame" });
    const { world, overlay } = this.layerPlan(availability);
    const drawable = this.context.getCurrentTexture();
    const multisampled = setup.sampleCount > 1;
    const casterPasses = shadowPlan.casterPasses;
    const hasOverlay = overlay.some((layer) => this.subsystems.some((s) => s.layers.includes(layer)));
    // The GPU time spans the frame's passes: the first one's start (a
    // compute pass of `prepareGPU` or the first render pass) to the last
    // render pass's end.
    const resolvesSceneDepth = keepsSceneDepth && multisampled;
    const renderPassCount = casterPasses.length + (shadowPlan.groundShadowMask ? 1 : 0) + 1 + (resolvesSceneDepth ? 1 : 0) + (fxaa ? 1 : 0) + (hasOverlay ? 1 : 0);
    let renderPassIndex = 0;
    let hasBegun = false;
    const profile = this.profilesPasses && this.timing !== undefined ? this.ensureProfiling() : undefined;
    const profiledNames: string[] = [];
    const profiled = (name: string): { querySet: GPUQuerySet; beginningOfPassWriteIndex: number; endOfPassWriteIndex: number } | undefined => {
      if (!profile || profiledNames.length >= profilingSlots) return undefined;
      const slot = profiledNames.push(name) - 1;
      return { querySet: profile.querySet, beginningOfPassWriteIndex: slot * 2, endOfPassWriteIndex: slot * 2 + 1 };
    };
    const computeTimestampWrites = (name: string): { timestampWrites?: GPUComputePassTimestampWrites } => {
      if (profile) {
        const writes = profiled(name);
        return writes ? { timestampWrites: writes } : {};
      }
      if (!this.timing || hasBegun) return {};
      hasBegun = true;
      return { timestampWrites: { querySet: this.timing.querySet, beginningOfPassWriteIndex: 0 } };
    };
    for (const s of this.subsystems) s.prepareGPU?.(context, encoder, computeTimestampWrites);

    const timestampWrites = (name: string): { timestampWrites?: GPURenderPassTimestampWrites } => {
      if (profile) {
        const writes = profiled(name);
        return writes ? { timestampWrites: writes } : {};
      }
      const isLast = renderPassIndex++ === renderPassCount - 1;
      const begins = !hasBegun;
      hasBegun = true;
      if (!this.timing || (!begins && !isLast)) return {};
      return {
        timestampWrites: {
          querySet: this.timing.querySet,
          ...(begins ? { beginningOfPassWriteIndex: 0 } : {}),
          ...(isLast ? { endOfPassWriteIndex: 1 } : {}),
        },
      };
    };

    // The shadow map first, then the ground's mask of it: the world samples both.
    for (const caster of casterPasses) {
      const pass = encoder.beginRenderPass({
        label: caster.layer,
        colorAttachments: [],
        depthStencilAttachment: { view: caster.view, depthClearValue: 1, depthLoadOp: caster.keepsDepth === true ? "load" : "clear", depthStoreOp: "store" },
        ...timestampWrites(caster.layer),
      });
      caster.encodeFirst?.(pass);
      this.encodeLayer(caster.layer, pass, context);
      pass.end();
    }
    if (shadowPlan.groundShadowMask) {
      const pass = encoder.beginRenderPass({
        label: "ground shadow mask",
        colorAttachments: [{ view: shadowPlan.groundShadowMask, clearValue: { r: 1, g: 1, b: 1, a: 1 }, loadOp: "clear", storeOp: "store" }],
        ...timestampWrites("groundShadowMask"),
      });
      this.encodeLayer("groundShadowMask", pass, context);
      pass.end();
    }

    const worldTarget = fxaa ? this.postProcessingTexture!.createView() : drawable.createView();
    // One world pass, or one a layer while profiling: the first clears, the
    // last resolves and drops what the frame does not keep, the ones between
    // load and store everything.
    const worldPasses: (readonly RenderLayer[])[] = profile && this.profilesWorldLayers ? world.map((layer) => [layer]) : [world];
    if (worldPasses.length === 0) worldPasses.push([]);
    worldPasses.forEach((layers, i) => {
      const first = i === 0;
      const last = i === worldPasses.length - 1;
      const worldPass = encoder.beginRenderPass({
        label: "world",
        colorAttachments: [
          {
            view: multisampled ? this.colorTexture!.createView() : worldTarget,
            ...(multisampled && last ? { resolveTarget: worldTarget } : {}),
            clearValue: setup.clearColor,
            loadOp: first ? "clear" : "load",
            storeOp: multisampled && last ? "discard" : "store",
          },
        ],
        depthStencilAttachment: {
          view: this.depthTexture!.createView(),
          depthClearValue: 1,
          depthLoadOp: first ? "clear" : "load",
          depthStoreOp: keepsSceneDepth || !last ? "store" : "discard",
          // The stencil carries the tile-priority marks and the surface bits: cleared to 0, never stored.
          stencilClearValue: 0,
          stencilLoadOp: first ? "clear" : "load",
          stencilStoreOp: last ? "discard" : "store",
        },
        ...timestampWrites(worldPasses.length > 1 ? `world ${layers[0] ?? ""}` : "world"),
      });
      for (const layer of layers) this.encodeLayer(layer, worldPass, context);
      worldPass.end();
    });

    if (resolvesSceneDepth) {
      // WebGPU resolves no depth: sample 0 of each pixel is copied by a
      // fullscreen pass, as the Swift depth resolve's `.sample0` filter.
      const pass = encoder.beginRenderPass({
        label: "scene depth resolve",
        colorAttachments: [],
        depthStencilAttachment: { view: this.sceneDepthViewOfFrame!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
        ...timestampWrites("sceneDepthResolve"),
      });
      const resolve = this.sceneDepthResolve!;
      pass.setPipeline(resolve.pipeline);
      pass.setBindGroup(0, resolve.group!);
      pass.draw(3);
      pass.end();
    }

    if (fxaa) {
      // The finished world into the drawable, every pixel written.
      const pass = encoder.beginRenderPass({
        label: "post-processing",
        colorAttachments: [{ view: drawable.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
        ...timestampWrites("postProcessing"),
      });
      this.encodeLayer("postProcessing", pass, context);
      pass.end();
    }

    if (hasOverlay) {
      // The overlay keeps its own pass over its own cleared depth (the labels' halo ordering).
      const overlayPass = encoder.beginRenderPass({
        label: "overlay",
        colorAttachments: [{ view: drawable.createView(), loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: this.overlayDepthTexture!.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
        ...timestampWrites("overlay"),
      });
      for (const layer of overlay) this.encodeLayer(layer, overlayPass, context);
      overlayPass.end();
    }

    const timing = profile ? undefined : this.timing;
    const readTiming = timing !== undefined && !timing.reading;
    const readProfile = profile !== undefined && !profile.reading && profiledNames.length > 0;
    if (profile && profiledNames.length > 0) {
      const count = profiledNames.length * 2;
      encoder.resolveQuerySet(profile.querySet, 0, count, profile.resolve, 0);
      if (readProfile) encoder.copyBufferToBuffer(profile.resolve, 0, profile.read, 0, count * 8);
    }
    if (timing) {
      encoder.resolveQuerySet(timing.querySet, 0, 2, timing.resolve, 0);
      if (readTiming) encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
    }
    this.drawParameters.flush();
    for (const flush of this.flushes) flush();
    device.queue.submit([encoder.finish()]);
    for (const s of this.subsystems) s.frameCommitted?.();
    if (timing && readTiming) {
      timing.reading = true;
      timing.read
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const [begin, end] = new BigInt64Array(timing.read.getMappedRange());
          this.gpuMilliseconds = Number(end! - begin!) / 1e6;
          timing.read.unmap();
        })
        .catch(() => undefined)
        .finally(() => {
          timing.reading = false;
        });
    }
    if (profile && readProfile) {
      profile.reading = true;
      profile.read
        .mapAsync(GPUMapMode.READ, 0, profiledNames.length * 16)
        .then(() => {
          const stamps = new BigInt64Array(profile.read.getMappedRange(0, profiledNames.length * 16));
          this.passProfile = profiledNames.map((name, i) => ({ name, start: Number(stamps[i * 2]! - stamps[0]!) / 1e6, milliseconds: Number(stamps[i * 2 + 1]! - stamps[i * 2]!) / 1e6 }));
          // The whole frame too, as the unprofiled frame measures it: the first pass's start to the last one's end.
          this.gpuMilliseconds = Number(stamps[profiledNames.length * 2 - 1]! - stamps[0]!) / 1e6;
          profile.read.unmap();
        })
        .catch(() => undefined)
        .finally(() => {
          profile.reading = false;
        });
    }
  }

  /** The profile's query set and buffers, made on its first frame: room for a pass a layer. */
  private ensureProfiling(): { querySet: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; reading: boolean } {
    if (this.profiling) return this.profiling;
    const { device } = this.gpu;
    const count = profilingSlots * 2;
    this.profiling = {
      querySet: device.createQuerySet({ type: "timestamp", count }),
      resolve: device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: device.createBuffer({ size: count * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      reading: false,
    };
    return this.profiling;
  }

  /** Lets the canvas go of this device, for another renderer to configure it with its own. */
  /**
   * Configures the canvas opaque unless the page has to show through it. An
   * opaque canvas needs no blending with the page under it, and the browser
   * can hand it to the display as it is, which costs less per frame and
   * presents sooner than a canvas with alpha.
   */
  setTransparent(transparent: boolean): void {
    const alphaMode: GPUCanvasAlphaMode = transparent ? "premultiplied" : "opaque";
    if (alphaMode === this.alphaMode) return;
    this.alphaMode = alphaMode;
    this.context.configure({ device: this.gpu.device, format: this.gpu.colorFormat, alphaMode });
  }

  unconfigure(): void {
    this.alphaMode = undefined;
    this.context.unconfigure();
  }

  destroy(): void {
    this.colorTexture?.destroy();
    this.depthTexture?.destroy();
    this.sceneDepthTexture?.destroy();
    this.overlayDepthTexture?.destroy();
    this.postProcessingTexture?.destroy();
    this.drawParameters.destroy();
    this.profiling?.querySet.destroy();
    this.profiling?.resolve.destroy();
    this.profiling?.read.destroy();
  }

  /** The frame's layers, planned again only when the availability changed (it changes rarely, a frame asks every time). */
  private layerPlan(availability: RenderPassAvailability): { world: RenderLayer[]; overlay: RenderLayer[] } {
    const cached = this.cachedPlan;
    if (cached && shallowEqual(cached.availability, availability)) return cached;
    const plan = planRenderLayers(availability).filter((i) => i.enabled).map((i) => i.layer);
    const next = { availability: { ...availability }, world: worldLayerOrder(plan.filter(isWorldLayer)), overlay: plan.filter(isOverlayLayer) };
    this.cachedPlan = next;
    return next;
  }

  private encodeLayer(layer: RenderLayer, pass: GPURenderPassEncoder, context: FrameContext): void {
    for (const s of this.subsystems) if (s.layers.includes(layer)) s.encode(layer, pass, context);
  }

  /** The world's depth kept for the overlay this frame (`FrameContext.sceneDepth`), `undefined` when the frame does not keep it. */
  get sceneDepth(): GPUTextureView | undefined {
    return this.sceneDepthViewOfFrame;
  }

  /**
   * The view the overlay reads the world's depth by: the world depth-stencil
   * itself, its depth aspect, with one sample, a single-sample depth32float
   * the resolve pass copies sample 0 into with several.
   */
  private ensureSceneDepth(width: number, height: number, sampleCount: number): GPUTextureView {
    const depth = this.depthTexture!;
    if (sampleCount <= 1) return depth.createView({ aspect: "depth-only" });
    const { device } = this.gpu;
    if (!this.sceneDepthTexture || this.sceneDepthTexture.width !== width || this.sceneDepthTexture.height !== height) {
      this.sceneDepthTexture?.destroy();
      this.sceneDepthTexture = device.createTexture({ label: "scene depth", size: [width, height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    }
    if (!this.sceneDepthResolve) {
      const layout = device.createBindGroupLayout({
        label: "scene depth resolve",
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", multisampled: true } }],
      });
      const module = device.createShaderModule({ label: "scene depth resolve", code: sceneDepthResolveSource });
      const pipeline = device.createRenderPipeline({
        label: "scene depth resolve",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: "sceneDepthResolveVertex" },
        fragment: { module, entryPoint: "sceneDepthResolveFragment", targets: [] },
        primitive: { topology: "triangle-list" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
      });
      this.sceneDepthResolve = { pipeline, layout, group: undefined, source: undefined };
    }
    const resolve = this.sceneDepthResolve;
    if (resolve.source !== depth) {
      resolve.source = depth;
      resolve.group = device.createBindGroup({ label: "scene depth resolve", layout: resolve.layout, entries: [{ binding: 0, resource: depth.createView({ aspect: "depth-only" }) }] });
    }
    return this.sceneDepthTexture.createView();
  }

  /** What FXAA reads this frame: the world pass's colour, `undefined` without FXAA. */
  get postProcessingInput(): GPUTexture | undefined {
    return this.postProcessingTexture;
  }

  private ensureAttachments(width: number, height: number, sampleCount: number, fxaa: boolean): void {
    const { device, colorFormat, depthStencilFormat } = this.gpu;
    const fits = (t: GPUTexture | undefined, samples: number) => t !== undefined && t.width === width && t.height === height && t.sampleCount === samples;
    if (sampleCount > 1 && !fits(this.colorTexture, sampleCount)) {
      this.colorTexture?.destroy();
      this.colorTexture = device.createTexture({ label: "world color", size: [width, height], sampleCount, format: colorFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    if (!fits(this.depthTexture, sampleCount)) {
      this.depthTexture?.destroy();
      this.depthTexture = device.createTexture({
        label: "world depth-stencil",
        size: [width, height],
        sampleCount,
        format: depthStencilFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    if (fxaa && !fits(this.postProcessingTexture, 1)) {
      this.postProcessingTexture?.destroy();
      this.postProcessingTexture = device.createTexture({
        label: "post-processing input",
        size: [width, height],
        format: colorFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    } else if (!fxaa && this.postProcessingTexture) {
      this.postProcessingTexture.destroy();
      this.postProcessingTexture = undefined;
    }
    if (!fits(this.overlayDepthTexture, 1)) {
      this.overlayDepthTexture?.destroy();
      this.overlayDepthTexture = device.createTexture({ label: "overlay depth", size: [width, height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
  }
}

/** Sample 0 of the multisampled world depth into a single-sample depth, pixel for pixel. */
const sceneDepthResolveSource = /* wgsl */ `
@group(0) @binding(0) var worldDepth: texture_depth_multisampled_2d;

@vertex
fn sceneDepthResolveVertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn sceneDepthResolveFragment(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
    return textureLoad(worldDepth, vec2i(position.xy), 0);
}
`;

function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
