// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { PinCountBadge, PinImage } from "../immersive-map-pin.ts";

/** A cell of the pin atlas: its page, its cell and its UV rectangle (min x, min y, max x, max y). */
export interface PinAtlasSlot {
  readonly pageIndex: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly uvRect: readonly [number, number, number, number];
}

/** Writes a picture into a cell of a page: the GPU upload, a recording in tests. False when the picture could not be drawn. */
export type PinAtlasUpload = (image: PinImage, slot: PinAtlasSlot, cellSize: number) => boolean;

/** A note on a picture that is not the cell's size and is resampled into it, the Swift `PinTextureRasterizer.imageSizeWarning`. */
export function pinImageSizeWarning(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): string | null {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) return null;
  return `Pin image size mismatch: source ${sourceWidth}x${sourceHeight}, expected ${targetWidth}x${targetHeight}; image will be resampled into the pin atlas.`;
}

interface SlotState {
  readonly slot: PinAtlasSlot;
  lastUsedFrame: number;
}

/**
 * The atlas of pin pictures, a port of the Swift `PinTextureAtlas`. Cells
 * are keyed by the picture object, not by the pin: thousands of pins that
 * share a picture share one cell. When it is full, the least recently used
 * cell not used by the current frame is taken: the atlas is a cache of the
 * visible scene.
 */
export class PinTextureAtlas {
  private readonly freeSlots: PinAtlasSlot[] = [];
  private readonly slotsByImage = new Map<PinImage, SlotState>();
  private currentFrame = 0;

  constructor(
    readonly atlasSize: number,
    readonly cellSize: number,
    readonly pagesMax: number,
    private readonly upload: PinAtlasUpload,
  ) {
    if (atlasSize % cellSize !== 0) throw new RangeError("The pin atlas size must be divisible by the pin cell size.");
    const cellsPerSide = atlasSize / cellSize;
    const inverse = 1 / atlasSize;
    for (let page = 0; page < pagesMax; page++) {
      for (let y = 0; y < cellsPerSide; y++) {
        for (let x = 0; x < cellsPerSide; x++) {
          this.freeSlots.push(
            Object.freeze({
              pageIndex: page,
              cellX: x,
              cellY: y,
              uvRect: [Math.fround(x * cellSize * inverse), Math.fround(y * cellSize * inverse), Math.fround((x + 1) * cellSize * inverse), Math.fround((y + 1) * cellSize * inverse)] as const,
            }),
          );
        }
      }
    }
  }

  get slotCapacity(): number {
    const cellsPerSide = this.atlasSize / this.cellSize;
    return cellsPerSide * cellsPerSide * this.pagesMax;
  }

  /** Marks the start of a frame: a cell the current frame used is never taken. */
  beginFrame(frameIndex: number): void {
    this.currentFrame = frameIndex;
  }

  /** The cell of a picture already in the atlas, marked as used this frame. */
  slot(image: PinImage): PinAtlasSlot | null {
    const state = this.slotsByImage.get(image);
    if (state === undefined) return null;
    state.lastUsedFrame = this.currentFrame;
    return state.slot;
  }

  /** Puts the picture into a free cell (or the least recently used one) and returns it, null when this frame's pictures fill the atlas. */
  uploadImage(image: PinImage): PinAtlasSlot | null {
    const existing = this.slotsByImage.get(image);
    if (existing !== undefined) return existing.slot;
    const slot = this.takeSlot();
    if (slot === null) return null;
    if (!this.upload(image, slot, this.cellSize)) {
      this.freeSlots.push(slot);
      return null;
    }
    this.slotsByImage.set(image, { slot, lastUsedFrame: this.currentFrame });
    return slot;
  }

  private takeSlot(): PinAtlasSlot | null {
    const free = this.freeSlots.pop();
    if (free !== undefined) return free;
    let oldestKey: PinImage | null = null;
    let oldestFrame = Number.POSITIVE_INFINITY;
    for (const [key, state] of this.slotsByImage) {
      if (state.lastUsedFrame < this.currentFrame && state.lastUsedFrame < oldestFrame) {
        oldestKey = key;
        oldestFrame = state.lastUsedFrame;
      }
    }
    if (oldestKey === null) return null;
    const evicted = this.slotsByImage.get(oldestKey)!;
    this.slotsByImage.delete(oldestKey);
    return evicted.slot;
  }
}

/** Writes a counter's picture into its cell: the GPU upload, a recording in tests. */
export type PinCountBadgeUpload = (text: string, x: number, y: number, cellSize: number) => boolean;

/**
 * The atlas of the round counters of merged pins, a port of the Swift
 * `PinCountBadgeAtlas`: a white circle with the number, "999+" above 999.
 * A counter is drawn the first time it is asked for.
 */
export class PinCountBadgeAtlas {
  static readonly maximumCount = 999;

  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  private readonly slotsByKey = new Map<number, readonly [number, number, number, number]>();

  constructor(
    badgePixelSize: number,
    private readonly upload: PinCountBadgeUpload,
    columns = 20,
  ) {
    this.cellSize = Math.max(1, badgePixelSize);
    this.columns = Math.max(1, columns);
    this.rows = Math.ceil((PinCountBadgeAtlas.maximumCount + 1) / this.columns);
  }

  get width(): number {
    return this.cellSize * this.columns;
  }

  get height(): number {
    return this.cellSize * this.rows;
  }

  /** The UV rectangle of a counter, null when it could not be drawn. */
  slot(badge: PinCountBadge): readonly [number, number, number, number] | null {
    const overflow = badge.count > PinCountBadgeAtlas.maximumCount;
    // The overflow's cell follows the last count's.
    const atlasIndex = overflow ? PinCountBadgeAtlas.maximumCount : Math.max(1, badge.count) - 1;
    const existing = this.slotsByKey.get(atlasIndex);
    if (existing !== undefined) return existing;
    const minX = (atlasIndex % this.columns) * this.cellSize;
    const minY = Math.floor(atlasIndex / this.columns) * this.cellSize;
    const text = overflow ? `${PinCountBadgeAtlas.maximumCount}+` : String(Math.max(1, badge.count));
    if (!this.upload(text, minX, minY, this.cellSize)) return null;
    const slot = [Math.fround(minX / this.width), Math.fround(minY / this.height), Math.fround((minX + this.cellSize) / this.width), Math.fround((minY + this.cellSize) / this.height)] as const;
    this.slotsByKey.set(atlasIndex, slot);
    return slot;
  }
}

/** Draws a counter: a white circle with a faint ring and the number in near black, three digits squeezed to fit. */
export function drawPinCountBadge(context: OffscreenCanvasRenderingContext2D, text: string, size: number): void {
  context.clearRect(0, 0, size, size);
  const inset = Math.max(size * 0.05, 1.5);
  const radius = size * 0.5 - inset;
  context.beginPath();
  context.arc(size * 0.5, size * 0.5, radius, 0, Math.PI * 2);
  context.fillStyle = "#fff";
  context.fill();
  context.lineWidth = Math.max(size * 0.03, 1);
  context.strokeStyle = "rgba(0, 0, 0, 0.10)";
  context.stroke();
  const fontScale = text.length <= 2 ? 1 : text.length === 3 ? 0.82 : 0.66;
  context.font = `bold ${size * 0.44 * fontScale}px system-ui, -apple-system, sans-serif`;
  context.fillStyle = "rgb(20, 20, 20)";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, size * 0.5, size * 0.5);
}
