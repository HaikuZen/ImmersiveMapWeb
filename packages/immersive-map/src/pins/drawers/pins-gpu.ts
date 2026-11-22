// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pins' GPU side, a port of the Swift `PinPipeline`, `PinBeamPipeline`,
 * `PinCountBadgePipeline`, `PinSDFResource` and the textures of
 * `PinTextureAtlas` and `PinCountBadgeAtlas`: three pipelines over one
 * group (the frame's uniform, the pins' records, the atlases and the
 * shape's distance field), drawn in the overlay pass.
 */

import type { PinSettings } from "../../configuration/pin-settings.ts";
import type { PinImage } from "../immersive-map-pin.ts";
import { PinImageLoader } from "../pin-image-loader.ts";
import type { PinStyleGPU } from "../pin-types.ts";
import { PinShapeDistanceField } from "../textures/pin-shape-distance-field.ts";
import { type PinAtlasSlot, drawPinCountBadge } from "../textures/pin-texture-atlas.ts";
import pinSource from "../shaders/pin.wgsl?raw";

/** Bytes of one pin's record (`PinRecord` in pin.wgsl). */
export const PIN_RECORD_BYTES = 128;
/** Bytes of the frame's uniform (`PinFrameUniform` in pin.wgsl). */
export const PIN_FRAME_UNIFORM_BYTES = 192;

/** The record's fields, in 4-byte words (`PinRecord` in pin.wgsl). */
export const PinRecordLayout = Object.freeze({
  words: PIN_RECORD_BYTES / 4,
  position: 0,
  visibilityAlpha: 2,
  visible: 3,
  uvRect: 4,
  borderColor: 8,
  squashScale: 12,
  atlasIndex: 14,
  flags: 15,
  morph: 16,
  badgeContentAlpha: 17,
  badgeFlags: 18,
  screenSizeScale: 19,
  badgeUvRect: 20,
  beamAnchor: 24,
  beamAnchorVisible: 26,
  beamAnchorAlpha: 27,
  beamOffset: 28,
  beamScale: 30,
});

/** The uniform's fields, in 4-byte words (`PinFrameUniform` in pin.wgsl). */
export const PinFrameUniformLayout = Object.freeze({
  screenMatrix: 0,
  style: 16,
  styleSizePx: 16,
  styleAnchorUv: 18,
  styleBodyCenterUv: 20,
  styleBodyHalfUv: 22,
  styleCircleRadiusUv: 24,
  styleOutlineWidthPx: 25,
  styleContentInsetPx: 26,
  styleDistanceRangeTexels: 27,
  styleFillColor: 28,
  styleFrameless: 32,
  styleDistanceInAlpha: 33,
  beamPinCenterOffsetPx: 36,
  beamPinBodyHalfMinPx: 38,
  beamColor: 40,
  badgeSizePx: 44,
  badgeOriginPx: 46,
});

/** Writes the style and the beam's and the counter's constants into the uniform's staging. The screen matrix is written each frame. */
export function writePinFrameConstants(
  f32: Float32Array,
  u32: Uint32Array,
  style: PinStyleGPU,
  beam: { readonly pinCenterOffsetPx: readonly [number, number]; readonly pinBodyHalfMinPx: number; readonly color: readonly number[] },
  badge: { readonly sizePx: readonly [number, number]; readonly originXPx: number; readonly originYPx: number },
): void {
  const l = PinFrameUniformLayout;
  f32.set(style.sizePx, l.styleSizePx);
  f32.set(style.anchorUv, l.styleAnchorUv);
  f32.set(style.bodyCenterUv, l.styleBodyCenterUv);
  f32.set(style.bodyHalfUv, l.styleBodyHalfUv);
  f32[l.styleCircleRadiusUv] = style.circleRadiusUv;
  f32[l.styleOutlineWidthPx] = style.outlineWidthPx;
  f32[l.styleContentInsetPx] = style.contentInsetPx;
  f32[l.styleDistanceRangeTexels] = style.distanceRangeTexels;
  f32.set(style.fillColor, l.styleFillColor);
  u32[l.styleFrameless] = style.frameless ? 1 : 0;
  u32[l.styleDistanceInAlpha] = style.distanceInAlpha ? 1 : 0;
  f32.set(beam.pinCenterOffsetPx, l.beamPinCenterOffsetPx);
  f32[l.beamPinBodyHalfMinPx] = beam.pinBodyHalfMinPx;
  f32.set(beam.color.slice(0, 4), l.beamColor);
  f32.set(badge.sizePx, l.badgeSizePx);
  f32[l.badgeOriginPx] = badge.originXPx;
  f32[l.badgeOriginPx + 1] = badge.originYPx;
}

/** The shape's distance field as the shader samples it, and the numbers it is read by. */
export interface PinShapeField {
  readonly texture: GPUTexture;
  readonly distanceRangeTexels: number;
  readonly distanceInAlpha: boolean;
  /** The built-in bubble's tail as its resource states it, null for another shape. */
  readonly bubbleTailHeight: number | null;
}

const bubbleSDFURL = new URL("../../../assets/pin_sdf.png", import.meta.url).href;
const bubbleSDFMetadataURL = new URL("../../../assets/pin_sdf.json", import.meta.url).href;

interface PinSDFMetadata {
  readonly schemaVersion: number;
  readonly distanceRangeTexels: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly pointerHeightRatio: number;
}

/** What a map's pins need before their first frame: the built-in bubble's field, or the picture of a mask shape. */
export type PinShapeResource = { readonly kind: "bubble"; readonly image: ImageBitmap; readonly metadata: PinSDFMetadata } | { readonly kind: "mask"; readonly image: ImageBitmap } | { readonly kind: "baked" };

/**
 * Loads what the shape needs, when the map is created: the bubble's field
 * from the package (`assets/pin_sdf.*`, distance in alpha), or the mask's
 * picture. A path or a frameless shape needs nothing loaded and is baked
 * on the first pin.
 */
export async function loadPinShapeResource(settings: PinSettings): Promise<PinShapeResource> {
  const shape = settings.shape;
  if (shape.kind === "bubble") {
    const [image, metadata] = await Promise.all([
      fetch(bubbleSDFURL).then(async (response) => {
        if (!response.ok) throw new Error(`ImmersiveMap could not load its pin shape ${bubbleSDFURL}: HTTP ${response.status}`);
        return createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      }),
      fetch(bubbleSDFMetadataURL).then(async (response) => {
        if (!response.ok) throw new Error(`ImmersiveMap could not load its pin shape ${bubbleSDFMetadataURL}: HTTP ${response.status}`);
        return (await response.json()) as PinSDFMetadata;
      }),
    ]);
    if (metadata.schemaVersion !== 1) throw new Error(`ImmersiveMap: the pin shape's metadata has schema ${metadata.schemaVersion}, 1 is supported.`);
    if (metadata.imageWidth !== image.width || metadata.imageHeight !== image.height) throw new Error("ImmersiveMap: the pin shape's metadata does not match its texture's size.");
    return { kind: "bubble", image, metadata };
  }
  if (shape.kind === "mask") {
    const response = await fetch(new URL(shape.maskURL, location.href));
    if (!response.ok) throw new Error(`ImmersiveMap could not load the pin shape's mask ${shape.maskURL}: HTTP ${response.status}`);
    return { kind: "mask", image: await createImageBitmap(await response.blob(), { colorSpaceConversion: "none" }) };
  }
  return { kind: "baked" };
}

/** The bubble's tail height its resource states, before the GPU exists (the style's metrics read it). */
export function pinShapeBubbleTailHeight(resource: PinShapeResource): number | null {
  return resource.kind === "bubble" ? resource.metadata.pointerHeightRatio : null;
}

export class PinsGpu {
  readonly bodyPipeline: GPURenderPipeline;
  readonly badgePipeline: GPURenderPipeline;
  readonly beamPipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  readonly uniformBuffer: GPUBuffer;
  private recordBuffer: GPUBuffer;
  private recordCapacity: number;
  private readonly sampler: GPUSampler;
  private readonly emptyAtlas: GPUTexture;
  private readonly emptyBadges: GPUTexture;
  private atlasTexture: GPUTexture | undefined;
  private badgeTexture: GPUTexture | undefined;
  private badgeCanvas: OffscreenCanvas | undefined;
  private cellCanvas: OffscreenCanvas | undefined;
  private shapeField: PinShapeField | undefined;
  private group: GPUBindGroup | undefined;

  private constructor(
    private readonly device: GPUDevice,
    pipelines: [GPURenderPipeline, GPURenderPipeline, GPURenderPipeline],
    layout: GPUBindGroupLayout,
    private readonly shapeResource: PinShapeResource,
    private readonly shapeSettings: PinSettings["shape"],
  ) {
    [this.beamPipeline, this.bodyPipeline, this.badgePipeline] = pipelines;
    this.layout = layout;
    this.uniformBuffer = device.createBuffer({ label: "pin frame", size: PIN_FRAME_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.recordCapacity = 64;
    this.recordBuffer = this.makeRecordBuffer(this.recordCapacity);
    this.sampler = device.createSampler({ label: "pins", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.emptyAtlas = device.createTexture({ label: "pin atlas (empty)", size: [1, 1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.emptyBadges = device.createTexture({ label: "pin counters (empty)", size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
  }

  /** Builds the pipelines (asynchronously, so no frame stalls on a compile) over the shape's loaded resource. */
  static async create(context: { readonly device: GPUDevice; readonly colorFormat: GPUTextureFormat }, settings: PinSettings, shapeResource: PinShapeResource): Promise<PinsGpu> {
    const { device } = context;
    const layout = device.createBindGroupLayout({
      label: "pins",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const module = device.createShaderModule({ label: "pins", code: pinSource });
    const pipelineLayout = device.createPipelineLayout({ label: "pins", bindGroupLayouts: [layout] });
    // Source-over with `one` for alpha, so coverage accumulates on a
    // transparent drawable (a pin off the globe's limb over clear space).
    const blend: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const pipeline = (name: string, vertex: string, fragment: string): Promise<GPURenderPipeline> =>
      device.createRenderPipelineAsync({
        label: `pins ${name}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: vertex },
        fragment: { module, entryPoint: fragment, targets: [{ format: context.colorFormat, blend }] },
        primitive: { topology: "triangle-list" },
        // The overlay pass's own depth: the pins neither test nor write it.
        depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "always" },
      });
    const pipelines = await Promise.all([pipeline("beam", "pinBeamVertex", "pinBeamFragment"), pipeline("body", "pinVertex", "pinFragment"), pipeline("counter", "pinCountBadgeVertex", "pinCountBadgeFragment")]);
    return new PinsGpu(device, pipelines, layout, shapeResource, settings.shape);
  }

  /** The numbers the shape's field is read by, known before it is made. */
  get shapeReading(): { readonly distanceRangeTexels: number; readonly distanceInAlpha: boolean } {
    return this.shapeResource.kind === "bubble"
      ? { distanceRangeTexels: this.shapeResource.metadata.distanceRangeTexels, distanceInAlpha: true }
      : { distanceRangeTexels: PinShapeDistanceField.distanceRangeTexels, distanceInAlpha: false };
  }

  /** Whether the atlases exist: a map that never drew a pin made none. */
  get hasAtlases(): boolean {
    return this.atlasTexture !== undefined;
  }

  /** The pins' atlas texture array, made on the first pin (`LazyPinRenderResource`). */
  ensureAtlas(atlasSize: number, pages: number): void {
    if (this.atlasTexture !== undefined) return;
    const limit = this.device.limits.maxTextureDimension2D;
    const side = Math.min(atlasSize, limit);
    this.atlasTexture = this.device.createTexture({
      label: "pin atlas",
      size: [side, side, Math.max(1, Math.min(pages, this.device.limits.maxTextureArrayLayers))],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.group = undefined;
  }

  /**
   * Draws a picture into its cell, resampled to the cell's size and stored
   * bottom row first, premultiplied (the Swift `makeBGRAData` with its
   * vertical flip): the shader reads the quad with y up.
   */
  uploadPicture(image: PinImage | null, slot: PinAtlasSlot, cellSize: number): boolean {
    const atlas = this.atlasTexture;
    if (atlas === undefined) return false;
    const source = image ?? PinImageLoader.defaultPlaceholder;
    let canvas = this.cellCanvas;
    if (canvas === undefined || canvas.width !== cellSize) {
      canvas = new OffscreenCanvas(cellSize, cellSize);
      this.cellCanvas = canvas;
    }
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, cellSize, cellSize);
    context.imageSmoothingQuality = "high";
    try {
      if (typeof ImageData !== "undefined" && source instanceof ImageData) {
        // An ImageData draws only at its own size: through a bitmap of it.
        const scratch = new OffscreenCanvas(source.width, source.height);
        scratch.getContext("2d")!.putImageData(source, 0, 0);
        context.drawImage(scratch, 0, 0, cellSize, cellSize);
      } else {
        context.drawImage(source as CanvasImageSource, 0, 0, cellSize, cellSize);
      }
    } catch {
      return false;
    }
    this.device.queue.copyExternalImageToTexture(
      { source: canvas, flipY: true },
      { texture: atlas, origin: [slot.cellX * cellSize, slot.cellY * cellSize, slot.pageIndex], premultipliedAlpha: true },
      [cellSize, cellSize],
    );
    return true;
  }

  /** The counters' atlas, made when the first counter is drawn. */
  ensureBadgeAtlas(width: number, height: number): void {
    if (this.badgeTexture !== undefined) return;
    this.badgeTexture = this.device.createTexture({
      label: "pin counters",
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.group = undefined;
  }

  /** Draws a counter into its cell, bottom row first, premultiplied. */
  uploadBadge(text: string, x: number, y: number, cellSize: number): boolean {
    const texture = this.badgeTexture;
    if (texture === undefined) return false;
    let canvas = this.badgeCanvas;
    if (canvas === undefined || canvas.width !== cellSize) {
      canvas = new OffscreenCanvas(cellSize, cellSize);
      this.badgeCanvas = canvas;
    }
    drawPinCountBadge(canvas.getContext("2d")!, text, cellSize);
    this.device.queue.copyExternalImageToTexture({ source: canvas, flipY: true }, { texture, origin: [x, y], premultipliedAlpha: true }, [cellSize, cellSize]);
    return true;
  }

  /**
   * The shape's distance field, made on the first pin: the bubble's from
   * the package, a path's or a mask's baked on the CPU, one texel for a
   * frameless shape.
   */
  ensureShapeField(): void {
    if (this.shapeField !== undefined) return;
    const resource = this.shapeResource;
    if (resource.kind === "bubble") {
      const texture = this.device.createTexture({
        label: "pin shape (bubble)",
        size: [resource.image.width, resource.image.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture({ source: resource.image }, { texture }, [resource.image.width, resource.image.height]);
      this.shapeField = { texture, distanceRangeTexels: resource.metadata.distanceRangeTexels, distanceInAlpha: true, bubbleTailHeight: resource.metadata.pointerHeightRatio };
    } else {
      const baked = PinShapeDistanceField.bake(this.shapeSettings, resource.kind === "mask" ? resource.image : null) ?? { side: 1, values: Float32Array.of(0) };
      const texture = this.device.createTexture({ label: "pin shape distance field", size: [baked.side, baked.side], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      const halves = halfFloats(baked.values);
      this.device.queue.writeTexture({ texture }, halves, { bytesPerRow: baked.side * 2 }, [baked.side, baked.side]);
      this.shapeField = { texture, distanceRangeTexels: PinShapeDistanceField.distanceRangeTexels, distanceInAlpha: false, bubbleTailHeight: null };
    }
    this.group = undefined;
  }

  /** Uploads the frame's records and uniform. */
  writeFrame(uniform: Float32Array<ArrayBuffer>, records: Float32Array<ArrayBuffer>, count: number): void {
    const { queue } = this.device;
    queue.writeBuffer(this.uniformBuffer, 0, uniform);
    if (count === 0) return;
    if (count > this.recordCapacity) {
      // The last frame's draws may still read the old buffer: WebGPU keeps it alive until they complete.
      this.recordBuffer.destroy();
      while (this.recordCapacity < count) this.recordCapacity *= 2;
      this.recordBuffer = this.makeRecordBuffer(this.recordCapacity);
      this.group = undefined;
    }
    queue.writeBuffer(this.recordBuffer, 0, records, 0, count * PinRecordLayout.words);
  }

  bindGroup(): GPUBindGroup {
    if (this.group === undefined) {
      const atlas = this.atlasTexture ?? this.emptyAtlas;
      this.group = this.device.createBindGroup({
        label: "pins",
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.recordBuffer } },
          { binding: 2, resource: atlas.createView({ dimension: "2d-array" }) },
          { binding: 3, resource: (this.shapeField?.texture ?? this.emptyBadges).createView() },
          { binding: 4, resource: this.sampler },
          { binding: 5, resource: (this.badgeTexture ?? this.emptyBadges).createView() },
        ],
      });
    }
    return this.group;
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.recordBuffer.destroy();
    this.emptyAtlas.destroy();
    this.emptyBadges.destroy();
    this.atlasTexture?.destroy();
    this.badgeTexture?.destroy();
    this.shapeField?.texture.destroy();
    if (this.shapeResource.kind !== "baked") this.shapeResource.image.close();
  }

  private makeRecordBuffer(records: number): GPUBuffer {
    return this.device.createBuffer({ label: "pin records", size: records * PIN_RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}

const halfScratch = new Float32Array(1);
const halfScratchBits = new Uint32Array(halfScratch.buffer);

/** IEEE half floats of values in 0...1 (the encoded field), rounded to nearest even, for an `r16float` texture. */
export function halfFloats(values: Float32Array): Uint16Array<ArrayBuffer> {
  const halves = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index++) {
    halfScratch[0] = values[index]!;
    const bits = halfScratchBits[0]!;
    const sign = (bits >>> 16) & 0x8000;
    const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
    const mantissa = bits & 0x7fffff;
    if (exponent <= 0) {
      // Subnormal or zero: the field's smallest values.
      if (exponent < -10) {
        halves[index] = sign;
        continue;
      }
      const full = mantissa | 0x800000;
      const shift = 14 - exponent;
      let half = full >>> shift;
      const remainder = full & ((1 << shift) - 1);
      const halfway = 1 << (shift - 1);
      if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
      halves[index] = sign | half;
      continue;
    }
    if (exponent >= 31) {
      halves[index] = sign | 0x7c00;
      continue;
    }
    let half = (exponent << 10) | (mantissa >>> 13);
    const remainder = mantissa & 0x1fff;
    if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half += 1;
    halves[index] = sign | half;
  }
  return halves;
}
