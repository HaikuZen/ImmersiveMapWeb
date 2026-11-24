// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The labels' GPU resources (the Swift `TextRenderer` pipelines, its atlas
 * textures, `PoiSpriteAtlas` and `SurfaceLabelPipeline`): the two font
 * atlases and the POI sprite atlas as textures, the overlay pipelines of the
 * screen labels, the world pipelines of the labels painted on the map, and
 * the per-frame buffers the screen label shaders read.
 *
 * The atlases are lossless WebP decoded by `createImageBitmap` with no
 * premultiplication and no colour conversion (docs/benchmarks/B13-atlas.md):
 * every channel of a distance field is significant.
 */

import { RenderCamera } from "../../camera/render-camera.ts";
import { mat4Invert } from "../../math/mat4-invert.ts";
import { mat4Multiply } from "../../math/matrix.ts";
import groundFog from "../../ground-fog/shaders/ground-fog.wgsl?raw";
import { globeModuleSource } from "../../globe/globe-shader-source.ts";
import type { LabelFontWeight } from "../../style/theme.ts";
import { labelVertexLayout } from "../../tile/store/prepared-labels.ts";
import labelText from "../shaders/label-text.wgsl?raw";
import surfaceLabel from "../shaders/surface-label.wgsl?raw";

/** The label vertex as the pipelines read it (`labelVertexLayout`, 32 bytes). */
const labelVertexBuffer: GPUVertexBufferLayout = {
  arrayStride: labelVertexLayout.stride,
  attributes: [
    { shaderLocation: 0, offset: labelVertexLayout.position, format: "float32x2" },
    { shaderLocation: 1, offset: labelVertexLayout.uv, format: "float32x2" },
    { shaderLocation: 2, offset: labelVertexLayout.labelIndex, format: "sint32" },
    { shaderLocation: 3, offset: labelVertexLayout.spriteUV, format: "float32x2" },
  ],
};

/** The surface labels read the anchor, the uv and the offset. */
const surfaceVertexBuffer: GPUVertexBufferLayout = {
  arrayStride: labelVertexLayout.stride,
  attributes: [
    { shaderLocation: 0, offset: labelVertexLayout.position, format: "float32x2" },
    { shaderLocation: 1, offset: labelVertexLayout.uv, format: "float32x2" },
    { shaderLocation: 3, offset: labelVertexLayout.spriteUV, format: "float32x2" },
  ],
};

/** Coverage accumulates on a transparent destination, over an opaque one the result is unchanged. */
const labelBlend: GPUBlendState = {
  color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

/** The URLs of the package's atlases. */
export const labelAtlasAssets = {
  bold: new URL("../../../assets/atlas.webp", import.meta.url).href,
  thin: new URL("../../../assets/atlas_thin.webp", import.meta.url).href,
  poi: new URL("../../../assets/poi_sprites.webp", import.meta.url).href,
} as const;

/** The byte length of the road names' scene uniform (RoadLabelScene in label-text.wgsl): two matrices, the eye and the enable flag, the viewport, padded to 16. */
export const ROAD_LABEL_SCENE_BYTES = 160;

/** What the road names hide behind this frame: the CPU camera matrix, the eye and the drawable in pixels. */
export interface RoadLabelSceneInput {
  readonly projectionView: Float64Array;
  readonly eye: readonly [number, number, number];
  readonly viewport: readonly [number, number];
}

/** The byte length of the overlay frame uniform: the screen matrix and the pixels per point, padded to 16. */
const LABEL_FRAME_UNIFORM_BYTES = 80;

export interface LabelGpuContext {
  readonly device: GPUDevice;
  readonly colorFormat: GPUTextureFormat;
  /** The world pass's depth-stencil format and sample count, for the surface labels. */
  readonly depthStencilFormat: GPUTextureFormat;
  readonly sampleCount: number;
  readonly clipDistances: boolean;
  /** The tile pipelines' frame layout (camera, overview fade, ground fog, globe), group 0 of the surface labels. */
  readonly tileFrameLayout: GPUBindGroupLayout;
  /** The draw-parameter layout (B6), group 1 of every label pipeline. */
  readonly drawLayout: GPUBindGroupLayout;
}

export type ScreenLabelPipeline = "text" | "roadText" | "poi" | "routeShield";
export type SurfaceLabelSurface = "flat" | "sphere" | "morph";

/** Decodes a lossless WebP atlas into a texture, every channel as it is stored. */
export async function loadLabelAtlasTexture(device: GPUDevice, url: string, label: string): Promise<GPUTexture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ImmersiveMap could not load its ${label} atlas ${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const texture = device.createTexture({
    label,
    size: [bitmap.width, bitmap.height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: false }, [bitmap.width, bitmap.height]);
  bitmap.close();
  return texture;
}

export class LabelGpu {
  readonly frameLayout: GPUBindGroupLayout;
  readonly textureLayout: GPUBindGroupLayout;
  /** The draw-parameter layout every label pipeline binds as group 1. */
  readonly drawLayout: GPUBindGroupLayout;
  /** The atlas bind groups (group 2): the bold and thin fonts and the POI sprites. */
  readonly atlasGroups: Readonly<Record<LabelFontWeight | "poi", GPUBindGroup>>;
  private readonly textures: GPUTexture[];
  /** The bold font's atlas, which the tile grid writes its texts from too. */
  readonly boldAtlas: GPUTexture;
  private readonly screenPipelines: Map<ScreenLabelPipeline, GPURenderPipeline>;
  private readonly surfacePipelines: Map<SurfaceLabelSurface, GPURenderPipeline>;
  private readonly frameUniform: GPUBuffer;
  private labelBuffer: GPUBuffer;
  private roadGlyphBuffer: GPUBuffer;
  private frameGroup: GPUBindGroup | undefined;
  private readonly sceneLayout: GPUBindGroupLayout;
  private readonly sceneUniform: GPUBuffer;
  private readonly fallbackDepth: GPUTexture;
  private readonly sceneStaging = new Float32Array(ROAD_LABEL_SCENE_BYTES / 4);
  private sceneGroupCache: { view: GPUTextureView | undefined; group: GPUBindGroup } | undefined;
  private readonly frameStaging = new Float32Array(LABEL_FRAME_UNIFORM_BYTES / 4);

  private constructor(
    private readonly device: GPUDevice,
    layouts: { frame: GPUBindGroupLayout; texture: GPUBindGroupLayout; draw: GPUBindGroupLayout; scene: GPUBindGroupLayout },
    textures: { bold: GPUTexture; thin: GPUTexture; poi: GPUTexture },
    screenPipelines: Map<ScreenLabelPipeline, GPURenderPipeline>,
    surfacePipelines: Map<SurfaceLabelSurface, GPURenderPipeline>,
  ) {
    this.frameLayout = layouts.frame;
    this.sceneLayout = layouts.scene;
    this.sceneUniform = device.createBuffer({ label: "road label scene", size: ROAD_LABEL_SCENE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Bound when the frame keeps no world depth: never read, since `enabled` is 0 then.
    this.fallbackDepth = device.createTexture({ label: "road label scene fallback", size: [1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.textureLayout = layouts.texture;
    this.drawLayout = layouts.draw;
    this.textures = [textures.bold, textures.thin, textures.poi];
    this.boldAtlas = textures.bold;
    this.screenPipelines = screenPipelines;
    this.surfacePipelines = surfacePipelines;
    const sampler = device.createSampler({ label: "label atlas", magFilter: "linear", minFilter: "linear" });
    const group = (texture: GPUTexture, label: string) =>
      device.createBindGroup({ label, layout: layouts.texture, entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] });
    this.atlasGroups = { bold: group(textures.bold, "label atlas bold"), thin: group(textures.thin, "label atlas thin"), poi: group(textures.poi, "poi sprites") };
    this.frameUniform = device.createBuffer({ label: "label frame", size: LABEL_FRAME_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.labelBuffer = this.storage("label records", 32 * 1024);
    this.roadGlyphBuffer = this.storage("road glyph records", 32 * 1024);
  }

  /** Loads the atlases and builds every label pipeline, so no frame stalls on a compile. */
  static async create(context: LabelGpuContext): Promise<LabelGpu> {
    const { device } = context;
    const frame = device.createBindGroupLayout({
      label: "label frame",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const texture = device.createBindGroupLayout({
      label: "label atlas",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    // Group 3: the world's depth the road names hide behind (RoadLabelScene).
    const scene = device.createBindGroupLayout({
      label: "road label scene",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      ],
    });
    const screenModule = device.createShaderModule({ label: "labels", code: labelText });
    const screenLayout = device.createPipelineLayout({ label: "labels", bindGroupLayouts: [frame, context.drawLayout, texture, scene] });
    // The overlay pass: one sample, its own depth (frame-engine.ts).
    const screen = (name: ScreenLabelPipeline, vertex: string, fragment: string): Promise<[ScreenLabelPipeline, GPURenderPipeline]> =>
      device
        .createRenderPipelineAsync({
          label: `labels ${name}`,
          layout: screenLayout,
          vertex: { module: screenModule, entryPoint: vertex, buffers: [labelVertexBuffer] },
          fragment: { module: screenModule, entryPoint: fragment, targets: [{ format: context.colorFormat, blend: labelBlend }] },
          primitive: { topology: "triangle-list" },
          depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less-equal" },
        })
        .then((pipeline) => [name, pipeline]);
    const surfaceModule = device.createShaderModule({ label: "surface labels", code: globeModuleSource(context.clipDistances, [groundFog], surfaceLabel) });
    const surfaceLayout = device.createPipelineLayout({ label: "surface labels", bindGroupLayouts: [context.tileFrameLayout, context.drawLayout, texture] });
    // The world pass, blended like the ground, tested against it and never written.
    const surface = (name: SurfaceLabelSurface, vertex: string): Promise<[SurfaceLabelSurface, GPURenderPipeline]> =>
      device
        .createRenderPipelineAsync({
          label: `surface labels ${name}`,
          layout: surfaceLayout,
          vertex: { module: surfaceModule, entryPoint: vertex, buffers: [surfaceVertexBuffer] },
          fragment: { module: surfaceModule, entryPoint: "surfaceLabelFragment", targets: [{ format: context.colorFormat, blend: labelBlend }] },
          // Every glyph is counter-clockwise in render space and neither surface's projection mirrors: culling the back faces removes the far side of the planet.
          primitive: { topology: "triangle-list", frontFace: "ccw", cullMode: "back" },
          depthStencil: { format: context.depthStencilFormat, depthWriteEnabled: false, depthCompare: "less" },
          multisample: { count: context.sampleCount },
        })
        .then((pipeline) => [name, pipeline]);
    const [bold, thin, poi, screenPipelines, surfacePipelines] = await Promise.all([
      loadLabelAtlasTexture(device, labelAtlasAssets.bold, "label atlas bold"),
      loadLabelAtlasTexture(device, labelAtlasAssets.thin, "label atlas thin"),
      loadLabelAtlasTexture(device, labelAtlasAssets.poi, "poi sprites"),
      Promise.all([
        screen("text", "labelVertex", "labelTextFragment"),
        screen("roadText", "roadLabelVertex", "roadLabelTextFragment"),
        screen("poi", "labelVertex", "poiSpriteFragment"),
        screen("routeShield", "labelVertex", "routeShieldFragment"),
      ]),
      Promise.all([surface("flat", "surfaceLabelFlatVertex"), surface("sphere", "surfaceLabelSphereVertex"), surface("morph", "surfaceLabelMorphVertex")]),
    ]);
    return new LabelGpu(device, { frame, texture, draw: context.drawLayout, scene }, { bold, thin, poi }, new Map(screenPipelines), new Map(surfacePipelines));
  }

  screenPipeline(name: ScreenLabelPipeline): GPURenderPipeline {
    return this.screenPipelines.get(name)!;
  }

  surfacePipeline(surface: SurfaceLabelSurface): GPURenderPipeline {
    return this.surfacePipelines.get(surface)!;
  }

  /**
   * Uploads the frame's records: the screen matrix and pixels per point, the
   * base labels' records and the road glyphs' records. The buffers grow by
   * doubling, and the bind group follows them.
   */
  writeFrame(screen: Float64Array, pixelsPerPoint: number, labels: Float32Array, labelFloats: number, roadGlyphs: Float32Array, roadGlyphFloats: number): void {
    const queue = this.device.queue;
    this.frameStaging.set(screen);
    this.frameStaging[16] = pixelsPerPoint;
    queue.writeBuffer(this.frameUniform, 0, this.frameStaging);
    const labelBytes = labelFloats * 4;
    if (labelBytes > this.labelBuffer.size) {
      this.labelBuffer.destroy();
      this.labelBuffer = this.storage("label records", grownSize(this.labelBuffer.size, labelBytes));
      this.frameGroup = undefined;
    }
    const roadBytes = roadGlyphFloats * 4;
    if (roadBytes > this.roadGlyphBuffer.size) {
      this.roadGlyphBuffer.destroy();
      this.roadGlyphBuffer = this.storage("road glyph records", grownSize(this.roadGlyphBuffer.size, roadBytes));
      this.frameGroup = undefined;
    }
    if (labelFloats > 0) queue.writeBuffer(this.labelBuffer, 0, labels.buffer, labels.byteOffset, labelBytes);
    if (roadGlyphFloats > 0) queue.writeBuffer(this.roadGlyphBuffer, 0, roadGlyphs.buffer, roadGlyphs.byteOffset, roadBytes);
  }

  /**
   * Writes the road names' scene uniform: the GPU camera matrix (whose z is
   * the world pass's depth), the inverse of the CPU's, the eye and the
   * drawable. `scene` undefined turns the test off.
   */
  writeScene(scene: RoadLabelSceneInput | undefined): void {
    const f = this.sceneStaging;
    f.fill(0);
    if (scene) {
      const gpu = mat4Multiply(new Float64Array(16), RenderCamera.gpuClipDepthAdjustment, scene.projectionView);
      const inverse = new Float64Array(16);
      if (mat4Invert(inverse, scene.projectionView)) {
        f.set(gpu, 0);
        f.set(inverse, 16);
        f[32] = scene.eye[0];
        f[33] = scene.eye[1];
        f[34] = scene.eye[2];
        new Uint32Array(f.buffer)[35] = 1;
        f[36] = scene.viewport[0];
        f[37] = scene.viewport[1];
      }
    }
    this.device.queue.writeBuffer(this.sceneUniform, 0, f);
  }

  /** The road names' scene group (group 3), over the frame's world depth or the fallback. */
  sceneBindGroup(depth: GPUTextureView | undefined): GPUBindGroup {
    const cached = this.sceneGroupCache;
    if (cached && cached.view === depth) return cached.group;
    const group = this.device.createBindGroup({
      label: "road label scene",
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.sceneUniform } },
        { binding: 1, resource: depth ?? this.fallbackDepth.createView() },
      ],
    });
    this.sceneGroupCache = { view: depth, group };
    return group;
  }

  /** The overlay frame group (group 0 of the screen label pipelines). */
  frameBindGroup(): GPUBindGroup {
    this.frameGroup ??= this.device.createBindGroup({
      label: "label frame",
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameUniform } },
        { binding: 1, resource: { buffer: this.labelBuffer } },
        { binding: 2, resource: { buffer: this.roadGlyphBuffer } },
      ],
    });
    return this.frameGroup;
  }

  destroy(): void {
    for (const texture of this.textures) texture.destroy();
    this.frameUniform.destroy();
    this.sceneUniform.destroy();
    this.fallbackDepth.destroy();
    this.labelBuffer.destroy();
    this.roadGlyphBuffer.destroy();
  }

  private storage(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}

/** The doubled size a buffer grows to for `needed` bytes. */
function grownSize(current: number, needed: number): number {
  let size = Math.max(current, 256);
  while (size < needed) size *= 2;
  return size;
}
