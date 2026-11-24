// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TileGridSettings } from "../configuration/tile-grid-settings.ts";
import { globeModuleSource } from "../globe/globe-shader-source.ts";
import { stageEntry } from "../render/core/stage-constants.ts";
import { GlobeSurfaceDepthRank } from "../tile/drawers/depth-rank.ts";
import tileGridSource from "./shaders/tile-grid.wgsl?raw";
import { TILE_GRID_ATLAS_GLYPH_FLOATS, type TileGridAtlas } from "./tile-grid-atlas.ts";
import { TILE_GRID_GLYPH_BYTES, TILE_GRID_TILE_BYTES, type WasmBytes } from "./tile-grid-frame.ts";

/** The surface the frame draws the grid on, `kTileGridSurface` in tile-grid.wgsl. */
export type TileGridSurface = "flat" | "sphere" | "morph";

const surfaceValue: Record<TileGridSurface, number> = { flat: 0, sphere: 1, morph: 2 };

export interface TileGridPipelineContext {
  readonly device: GPUDevice;
  readonly colorFormat: GPUTextureFormat;
  readonly clipDistances: boolean;
  /** The frame's camera uniform (`writeGpuCameraUniform`). */
  readonly cameraBuffer: GPUBuffer;
  /** The frame's globe uniform (`GlobeFrameUniformLayout`). */
  readonly globeBuffer: GPUBuffer;
}

/**
 * The clip-space depth the tile grid is given, the Swift `TileGridDepth`.
 * The grid is not tested against any depth, so this only keeps it within
 * the clip volume: just inside the far plane, as the ground's own layers
 * are.
 */
export const TileGridDepth = {
  depth: 1 - GlobeSurfaceDepthRank.realGeometryRank * GlobeSurfaceDepthRank.layerDepthStep,
} as const;

/** Mirrors `TileGridFrame` in tile-grid.wgsl: the frame's look. */
export const TileGridFrameLayout = {
  byteLength: 112,
  lineColor: 0,
  selectedFillColor: 16,
  labelColor: 32,
  labelHaloColor: 48,
  viewport: 64,
  halfLineWidthPx: 72,
  minimumTilePx: 76,
  depth: 80,
  atlasDistanceRange: 84,
  atlasEmTexels: 88,
  haloWidthPx: 92,
  labelMinimumTilePx: 96,
} as const;

/** Writes the frame's look into `target` (its staging, 28 floats). Nothing is allocated. */
export function writeTileGridFrameUniform(target: Float32Array, settings: TileGridSettings, drawWidth: number, drawHeight: number, pixelsPerPoint: number, atlas: TileGridAtlas | undefined): void {
  const L = TileGridFrameLayout;
  target.set(settings.lineColor, L.lineColor / 4);
  target.set(settings.selectedFillColor, L.selectedFillColor / 4);
  target.set(settings.labelColor, L.labelColor / 4);
  target.set(settings.labelHaloColor, L.labelHaloColor / 4);
  target[L.viewport / 4] = drawWidth;
  target[L.viewport / 4 + 1] = drawHeight;
  target[L.halfLineWidthPx / 4] = settings.lineWidthPoints * pixelsPerPoint * 0.5;
  target[L.minimumTilePx / 4] = settings.minimumTileScreenPoints * pixelsPerPoint;
  target[L.depth / 4] = TileGridDepth.depth;
  target[L.atlasDistanceRange / 4] = atlas?.distanceRange ?? 1;
  target[L.atlasEmTexels / 4] = atlas?.emTexels ?? 1;
  target[L.haloWidthPx / 4] = settings.labelHaloWidthPoints * pixelsPerPoint;
  target[L.labelMinimumTilePx / 4] = settings.labelMinimumTileScreenPoints * pixelsPerPoint;
}

/** What a frame draws of the grid (`TileGridFrame`). */
export interface TileGridDraw {
  readonly surface: TileGridSurface;
  readonly plainCount: number;
  readonly selectedCount: number;
  readonly otherCount: number;
  readonly gridSubdivision: number;
  readonly otherSubdivision: number;
  readonly glyphCount: number;
  /** Whether the texts are drawn with their outline: its width is not zero. */
  readonly drawsHalo: boolean;
}

interface States {
  readonly patch: GPURenderPipeline;
  readonly frame: GPURenderPipeline;
  readonly glyph: GPURenderPipeline;
}

/** Blended over the frame, as the Swift pipeline: straight alpha in, the frame's alpha kept. */
const blend: GPUBlendState = {
  color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

const glyphBuffers: GPUVertexBufferLayout[] = [
  {
    arrayStride: TILE_GRID_GLYPH_BYTES,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 0, offset: 0, format: "uint32" },
      { shaderLocation: 1, offset: 4, format: "float32x2" },
      { shaderLocation: 2, offset: 12, format: "float32" },
    ],
  },
];

/**
 * The pipelines of the tile grid (tile-grid.wgsl), the Swift
 * `TileGridPipeline`: the patch of a selected tile, which carries its fill
 * and its border, the frame of a tile that is not selected, its border
 * alone (docs/benchmarks/B23-tile-grid.md), and the glyphs of the texts,
 * each in one variant per surface the ground is drawn on, in the overlay
 * pass's formats and its one sample, blended over the frame and tested
 * against no depth. With them the buffers a frame's grid is written into
 * and the one bind group every draw of the grid reads.
 *
 * The pipelines are compiled once a grid first has something to draw, so a
 * map without a grid compiles none of them.
 */
export class TileGridPipeline {
  /** The quads along a side of the lattice every patch is cut from: the finest a tile is divided. `kTileGridLatticePoints` in tile-grid.wgsl is one more. */
  static readonly latticeSide = 64;
  /** How many quads along a side a patch may be drawn with, each a run of indices over the one lattice. */
  static readonly subdivisions: readonly number[] = [1, 4, 8, 16, 32, 64];

  /**
   * Whether a tile that is not selected is drawn as the frame of its border
   * and not as a whole patch. On: the measurement's verdict. Off draws
   * every tile as the Swift engine does, for the measurement to compare.
   */
  drawsFrames = true;

  private readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly frameUniform: GPUBuffer;
  private readonly latticeIndices: GPUBuffer;
  private readonly latticeRanges = new Map<number, { first: number; count: number }>();
  private readonly fallbackAtlas: GPUTexture;
  private readonly fallbackGlyphTable: GPUBuffer;
  private tileBuffer: GPUBuffer;
  private glyphBuffer: GPUBuffer;
  private glyphTable: GPUBuffer | undefined;
  private atlasView: GPUTextureView | undefined;
  private group: GPUBindGroup | undefined;
  private states: Map<TileGridSurface, States> | undefined;
  private compiling: Promise<void> | undefined;
  private failed = false;

  constructor(readonly context: TileGridPipelineContext) {
    const { device } = context;
    this.layout = device.createBindGroupLayout({
      label: "tile grid",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: {} },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.sampler = device.createSampler({ label: "tile grid atlas", magFilter: "linear", minFilter: "linear" });
    this.frameUniform = device.createBuffer({ label: "tile grid frame", size: TileGridFrameLayout.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Bound until the atlas is at hand: a grid without texts reads neither.
    this.fallbackAtlas = device.createTexture({ label: "tile grid atlas fallback", size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.fallbackGlyphTable = device.createBuffer({ label: "tile grid glyph table fallback", size: TILE_GRID_ATLAS_GLYPH_FLOATS * 4, usage: GPUBufferUsage.STORAGE });
    this.tileBuffer = this.makeTileBuffer(64 * TILE_GRID_TILE_BYTES);
    this.glyphBuffer = this.makeGlyphBuffer(1024 * TILE_GRID_GLYPH_BYTES);

    const indices: number[] = [];
    for (const subdivision of TileGridPipeline.subdivisions) {
      const run = TileGridPipeline.latticeIndices(subdivision);
      this.latticeRanges.set(subdivision, { first: indices.length, count: run.length });
      indices.push(...run);
    }
    const data = new Uint16Array(indices);
    this.latticeIndices = device.createBuffer({ label: "tile grid lattice", size: Math.ceil(data.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint16Array(this.latticeIndices.getMappedRange()).set(data);
    this.latticeIndices.unmap();
  }

  /**
   * The triangles of a patch of `subdivision` quads a side, over the points
   * of the one lattice of `latticeSide` quads a side, which the vertex stage
   * places by their index alone.
   */
  static latticeIndices(subdivision: number): number[] {
    const step = TileGridPipeline.latticeSide / subdivision;
    const points = TileGridPipeline.latticeSide + 1;
    const indices: number[] = [];
    for (let row = 0; row < subdivision; row++) {
      for (let column = 0; column < subdivision; column++) {
        const topLeft = row * step * points + column * step;
        const topRight = topLeft + step;
        const bottomLeft = topLeft + step * points;
        const bottomRight = bottomLeft + step;
        indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
      }
    }
    return indices;
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
        console.error(`ImmersiveMap could not compile the tile grid's pipelines: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** The font the texts are drawn from: the bold label atlas and its glyphs. */
  setAtlas(texture: GPUTexture, atlas: TileGridAtlas): void {
    const { device } = this.context;
    this.glyphTable?.destroy();
    this.glyphTable = device.createBuffer({ label: "tile grid glyph table", size: Math.max(atlas.table.byteLength, TILE_GRID_ATLAS_GLYPH_FLOATS * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.glyphTable, 0, atlas.table);
    this.atlasView = texture.createView();
    this.group = undefined;
  }

  /** Whether the texts have their font. */
  get hasAtlas(): boolean {
    return this.atlasView !== undefined;
  }

  writeFrameUniform(staging: Float32Array): void {
    this.context.device.queue.writeBuffer(this.frameUniform, 0, staging);
  }

  /** The frame's tiles, from the module's memory. */
  writeTiles(bytes: WasmBytes): void {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > this.tileBuffer.size) {
      this.tileBuffer.destroy();
      this.tileBuffer = this.makeTileBuffer(grown(this.tileBuffer.size, bytes.byteLength));
      this.group = undefined;
    }
    this.context.device.queue.writeBuffer(this.tileBuffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** The frame's glyphs, from the module's memory. */
  writeGlyphs(bytes: WasmBytes): void {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > this.glyphBuffer.size) {
      this.glyphBuffer.destroy();
      this.glyphBuffer = this.makeGlyphBuffer(grown(this.glyphBuffer.size, bytes.byteLength));
    }
    this.context.device.queue.writeBuffer(this.glyphBuffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * The grid's draws, into the overlay pass: the fills of the other zooms'
   * selected tiles under the grid's own tiles, then the texts, every halo
   * and then every fill over them. Returns the number of draws.
   */
  draw(pass: GPURenderPassEncoder, draw: TileGridDraw): number {
    const states = this.states?.get(draw.surface);
    if (states === undefined) return 0;
    pass.setBindGroup(0, this.bindGroup());
    let draws = 0;
    const gridCount = draw.plainCount + draw.selectedCount;
    const patches = (first: number, count: number, subdivision: number): void => {
      if (count === 0) return;
      const range = this.latticeRanges.get(subdivision) ?? this.latticeRanges.get(TileGridPipeline.latticeSide)!;
      pass.drawIndexed(range.count, count, range.first, 0, first);
      draws++;
    };
    const patchFirst = this.drawsFrames ? draw.plainCount : 0;
    if (draw.otherCount > 0 || gridCount > patchFirst) {
      pass.setPipeline(states.patch);
      pass.setIndexBuffer(this.latticeIndices, "uint16");
      patches(gridCount, draw.otherCount, draw.otherSubdivision);
      patches(patchFirst, gridCount - patchFirst, draw.gridSubdivision);
    }
    if (this.drawsFrames && draw.plainCount > 0) {
      pass.setPipeline(states.frame);
      // Four sides, each a run of quads.
      pass.draw(24 * draw.gridSubdivision, draw.plainCount, 0, 0);
      draws++;
    }
    if (draw.glyphCount > 0 && this.atlasView !== undefined) {
      pass.setPipeline(states.glyph);
      pass.setVertexBuffer(0, this.glyphBuffer);
      // The halo's draw starts at vertex 6 (tileGridGlyphVertex).
      if (draw.drawsHalo) {
        pass.draw(6, draw.glyphCount, 6, 0);
        draws++;
      }
      pass.draw(6, draw.glyphCount, 0, 0);
      draws++;
    }
    return draws;
  }

  destroy(): void {
    this.frameUniform.destroy();
    this.latticeIndices.destroy();
    this.fallbackAtlas.destroy();
    this.fallbackGlyphTable.destroy();
    this.tileBuffer.destroy();
    this.glyphBuffer.destroy();
    this.glyphTable?.destroy();
  }

  private makeTileBuffer(size: number): GPUBuffer {
    return this.context.device.createBuffer({ label: "tile grid tiles", size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private makeGlyphBuffer(size: number): GPUBuffer {
    return this.context.device.createBuffer({ label: "tile grid glyphs", size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  private bindGroup(): GPUBindGroup {
    this.group ??= this.context.device.createBindGroup({
      label: "tile grid",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.context.cameraBuffer } },
        { binding: 1, resource: { buffer: this.context.globeBuffer } },
        { binding: 2, resource: { buffer: this.frameUniform } },
        { binding: 3, resource: { buffer: this.tileBuffer } },
        { binding: 4, resource: { buffer: this.glyphTable ?? this.fallbackGlyphTable } },
        { binding: 5, resource: this.atlasView ?? this.fallbackAtlas.createView() },
        { binding: 6, resource: this.sampler },
      ],
    });
    return this.group;
  }

  private async compile(): Promise<Map<TileGridSurface, States>> {
    const { device, colorFormat, clipDistances } = this.context;
    const code = globeModuleSource(clipDistances, [], tileGridSource);
    const module = device.createShaderModule({ label: "tile grid", code });
    const layout = device.createPipelineLayout({ label: "tile grid", bindGroupLayouts: [this.layout] });
    const make = (surface: TileGridSurface, kind: "patch" | "frame" | "glyph"): Promise<GPURenderPipeline> => {
      const constants = { kTileGridSurface: surfaceValue[surface] };
      const vertexEntry = kind === "patch" ? "tileGridPatchVertex" : kind === "frame" ? "tileGridFrameVertex" : "tileGridGlyphVertex";
      const fragmentEntry = kind === "glyph" ? "tileGridGlyphFragment" : "tileGridPatchFragment";
      return device.createRenderPipelineAsync({
        label: `tile grid ${kind} ${surface}`,
        layout,
        vertex: { module, ...stageEntry(code, vertexEntry, constants), buffers: kind === "glyph" ? glyphBuffers : [] },
        fragment: { module, ...stageEntry(code, fragmentEntry, constants), targets: [{ format: colorFormat, blend }] },
        // A patch that crosses the limb is cut by its clip distance, and a patch has no back to cull.
        primitive: { topology: "triangle-list", cullMode: "none" },
        // The overlay pass's own depth (frame-engine.ts), neither read nor written.
        depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "always" },
      });
    };
    const entries = (["flat", "sphere", "morph"] as const).map(
      async (surface): Promise<[TileGridSurface, States]> => {
        const [patch, frame, glyph] = await Promise.all([make(surface, "patch"), make(surface, "frame"), make(surface, "glyph")]);
        return [surface, { patch, frame, glyph }];
      },
    );
    return new Map(await Promise.all(entries));
  }
}

/** A buffer's next size: doubled until it holds `needed` bytes. */
function grown(size: number, needed: number): number {
  let next = Math.max(size, 64);
  while (next < needed) next *= 2;
  return next;
}
